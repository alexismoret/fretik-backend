import { and, eq, notInArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { workflowRuns, workflows } from "../../db/schema";
import type {
  WorkflowRunError,
  WorkflowRunOutput,
  WorkflowRunUsage,
} from "../../schemas/workflows";
import { emitDomainEvent } from "../domain-events/emit";

/** Terminal run statuses `finalizeRun` may set. */
export type FinalRunStatus = "succeeded" | "failed" | "canceled";

/**
 * Close a run: set its terminal status + summary/outputs/error, stamp
 * `finishedAt`, clear the wait token, journal `workflow.run.completed`
 * (which the memory pipeline distills into an episode), and bump the
 * workflow's `lastRunAt` — all in ONE transaction. Idempotent: a run
 * already in a terminal state is left untouched.
 *
 * Returns whether THIS call performed the terminal transition — the
 * exactly-once signal completion side effects (the notification email)
 * key on. The loser of a finalize race gets `transitioned: false`.
 */
export const finalizeRun = async (params: {
  tx?: Transaction;
  runId: string;
  status: FinalRunStatus;
  outputSummary?: string | null;
  outputs?: WorkflowRunOutput[] | null;
  error?: WorkflowRunError | null;
  usage?: WorkflowRunUsage;
  now?: Date;
}): Promise<{ transitioned: boolean }> => {
  const now = params.now ?? new Date();
  const run = async (tx: Transaction): Promise<boolean> => {
    // Atomic idempotent close: the terminal-status guard lives in the UPDATE
    // itself, so two concurrent finalizes (a cancel racing the turn's own
    // close) can't both pass a read-then-write check — exactly one wins, the
    // loser matches zero rows and no-ops.
    const [updated] = await tx
      .update(workflowRuns)
      .set({
        status: params.status,
        ...(params.outputSummary !== undefined
          ? { outputSummary: params.outputSummary }
          : {}),
        ...(params.outputs !== undefined ? { outputs: params.outputs } : {}),
        ...(params.error !== undefined ? { error: params.error } : {}),
        ...(params.usage !== undefined ? { usage: params.usage } : {}),
        waitTokenId: null,
        finishedAt: now,
        lastHeartbeatAt: now,
      })
      .where(
        and(
          eq(workflowRuns.id, params.runId),
          notInArray(workflowRuns.status, ["succeeded", "failed", "canceled"]),
        ),
      )
      .returning({
        organizationId: workflowRuns.organizationId,
        teamId: workflowRuns.teamId,
        workflowId: workflowRuns.workflowId,
        conversationId: workflowRuns.conversationId,
        triggerType: workflowRuns.triggerType,
        isTest: workflowRuns.isTest,
      });
    // Missing run or already terminal — nothing to do.
    if (!updated) return false;
    const existing = updated;

    await tx
      .update(workflows)
      .set({ lastRunAt: now })
      .where(eq(workflows.id, existing.workflowId));

    await emitDomainEvent({
      tx,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      type: "workflow.run.completed",
      actor: {
        actorType: "workflow",
        conversationId: existing.conversationId,
        agentKey: `workflow:${existing.workflowId}`,
      },
      payload: {
        runId: params.runId,
        workflowId: existing.workflowId,
        status: params.status,
        // Consumed by the memory sweep's distill gate: test runs are builder
        // scratch (never distilled), and cron runs distill at most once per
        // day (they would otherwise flood recall with ~24 near-identical
        // episodes daily). Manual/event runs distill on every success.
        triggerType: existing.triggerType,
        isTest: existing.isTest,
      },
      dedupKey: `workflow.run.completed:${params.runId}`,
    });
    return true;
  };

  if (params.tx) {
    return { transitioned: await run(params.tx) };
  }
  return { transitioned: await db.transaction(run) };
};
