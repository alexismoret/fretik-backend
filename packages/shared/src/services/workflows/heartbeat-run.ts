import { eq } from "drizzle-orm";
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
 */
export const setRunWaitToken = async (params: {
  runId: string;
  waitTokenId: string;
}): Promise<void> => {
  await db
    .update(workflowRuns)
    .set({ waitTokenId: params.waitTokenId, status: "needs_approval" })
    .where(eq(workflowRuns.id, params.runId));
};
