import { eq, sql } from "drizzle-orm";
import type { Transaction } from "../../db";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import type { WorkflowTurnResult } from "../../schemas/workflows";

/**
 * Advance a run's idempotency cursor + usage + task snapshot after one agent
 * turn — written in the SAME transaction as the turn's persisted assistant
 * messages (the outbox guarantee: both commit or neither). A retried turn
 * whose `turnIndex <= last_turn_index` is a replay; the AI handler checks
 * that BEFORE running the model and returns the recorded `last_turn_result`
 * instead of re-executing.
 *
 * Only the non-terminal statuses touch `status` here (`continue` → running,
 * `needs_approval` → needs_approval). Terminal turns (`completed` / `failed`
 * / `canceled`) are closed by `finalizeRun` in the same transaction, which
 * owns the summary, outputs, journal event, and `lastRunAt`.
 */
export const recordTurnResult = async (params: {
  tx?: Transaction;
  runId: string;
  result: WorkflowTurnResult;
  now?: Date;
}): Promise<void> => {
  const exec = params.tx ?? db;
  const now = params.now ?? new Date();
  const runStatus =
    params.result.status === "needs_approval" ? "needs_approval" : "running";

  await exec
    .update(workflowRuns)
    .set({
      lastTurnIndex: params.result.turnIndex,
      lastTurnResult: params.result,
      turnCount: params.result.turnIndex,
      usage: params.result.usage,
      taskStates: params.result.taskStates,
      lastHeartbeatAt: now,
      // Stamp startedAt on the first turn only (COALESCE keeps a prior value).
      startedAt: sql`COALESCE(${workflowRuns.startedAt}, ${now})`,
      ...(params.result.status === "continue" ||
      params.result.status === "needs_approval"
        ? { status: runStatus }
        : {}),
    })
    .where(eq(workflowRuns.id, params.runId));
};
