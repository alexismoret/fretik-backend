import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * Stamp a `running` run's `lastHeartbeatAt` — a liveness signal, refreshed
 * every turn. It ONLY matters while a run is actively `running`: the stall
 * sweeper (`markStalledRuns`) reclaims a run as `failed(STALLED)` when it is
 * still `running` but hasn't beaten for ~20 min, which can only mean the
 * Trigger.dev orchestrator process crashed and will never resume it.
 *
 * A run in `needs_approval` is NOT covered by that check — the sweeper
 * filters on `status = 'running'` — so an approval can sit pending for days
 * (bounded only by the wait-token timeout) without ever being killed. The
 * orchestrator is checkpointed on `wait.forToken` while it waits (zero cost),
 * so a stale heartbeat during approval is expected and harmless.
 */
export const heartbeatRun = async (params: {
  runId: string;
  now?: Date;
}): Promise<void> => {
  await db
    .update(workflowRuns)
    .set({ lastHeartbeatAt: params.now ?? new Date() })
    .where(eq(workflowRuns.id, params.runId));
};

/**
 * Record the approval wait-token id on a run as it enters `needs_approval`.
 * The approval-decision path reads it back to `wait.completeToken`, resuming
 * the orchestrator loop.
 *
 * The run is ALREADY `needs_approval` by the time this lands: the turn's own
 * transaction (`recordTurnResult`) writes that status before the orchestrator
 * gets the result and mints the token. So the guard admits both non-terminal
 * states — a `status = 'running'` filter matched zero rows, left
 * `waitTokenId` NULL, and stranded every approval (`resumeRunFromApproval`
 * bails without a token, so the run sat until APPROVAL_TIMEOUT and the
 * notification email never fired).
 *
 * `waitTokenId IS NULL` carries the rest of the contract: a terminal or
 * canceled run is never dragged back to `needs_approval`, and a retried/late
 * POST matches nothing — so the returned `parked` stays the exactly-once
 * signal the approval notification email keys on.
 */
export const setRunWaitToken = async (params: {
  runId: string;
  waitTokenId: string;
}): Promise<{ parked: boolean }> => {
  const updated = await db
    .update(workflowRuns)
    .set({ waitTokenId: params.waitTokenId, status: "needs_approval" })
    .where(
      and(
        eq(workflowRuns.id, params.runId),
        inArray(workflowRuns.status, ["running", "needs_approval"]),
        isNull(workflowRuns.waitTokenId),
      ),
    )
    .returning({ id: workflowRuns.id });
  return { parked: updated.length > 0 };
};
