import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * Flip a run `queued → running` at the start of its first turn. Until now the
 * DB status only became `running` when the FIRST turn RESULT was recorded, so
 * between enqueue and end-of-turn-1 the row read `queued` even though the model
 * was already working — and the stall sweeper (which only scans `running`)
 * couldn't catch a turn-1 crash. Idempotent: the `status = 'queued'` guard
 * makes the whole update no-op once the run has left `queued`, so `startedAt`
 * is stamped exactly once and a later status is never clobbered on replay.
 */
export const startRunning = async (params: {
  runId: string;
}): Promise<void> => {
  const now = new Date();
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: now, lastHeartbeatAt: now })
    .where(
      and(eq(workflowRuns.id, params.runId), eq(workflowRuns.status, "queued")),
    );
};
