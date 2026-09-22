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
 * without ever being killed. A stale heartbeat during a park is expected:
 * there is no orchestrator at all while a run waits on a human (it exited),
 * so nothing is there to beat. The park's own bound is `paused_at` against
 * `WORKFLOW_APPROVAL_TIMEOUT_MINUTES`, enforced by the same sweeper.
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
 * Record where a run parked on a human picks up again, as it enters
 * `needs_approval` and its orchestrator exits. `resumeRunFromApproval`
 * reads these back to start a fresh orchestrator at that turn.
 *
 * The `resumeFromTurnIndex IS NULL` guard does double duty: it is the
 * exactly-once signal the approval email keys on (below), AND the write half
 * of the claim that stops two decisions on the same approval from launching
 * two orchestrators — the resume clears it under `IS NOT NULL`.
 *
 * The run is ALREADY `needs_approval` by the time this lands: the turn's own
 * transaction (`recordTurnResult`) writes that status — and `pausedAt`,
 * which is what bounds the park — before the orchestrator gets the result.
 * So the guard admits both non-terminal states; a `status = 'running'`
 * filter matched zero rows and stranded every approval.
 */
export const parkRunForApproval = async (params: {
  runId: string;
  resumeFromTurnIndex: number;
  remainingMs: number;
}): Promise<{ parked: boolean }> => {
  const updated = await db
    .update(workflowRuns)
    .set({
      resumeFromTurnIndex: params.resumeFromTurnIndex,
      resumeRemainingMs: params.remainingMs,
      status: "needs_approval",
    })
    .where(
      and(
        eq(workflowRuns.id, params.runId),
        inArray(workflowRuns.status, ["running", "needs_approval"]),
        isNull(workflowRuns.resumeFromTurnIndex),
      ),
    )
    .returning({ id: workflowRuns.id });
  return { parked: updated.length > 0 };
};
