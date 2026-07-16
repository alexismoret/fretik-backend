import { and, eq, lt, or, sql } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { finalizeRun } from "./finalize-run";
import { sendRunCompletionEmailIfEnabled } from "./send-run-completion-email";

/** A run is stalled if it's still `running` but hasn't beaten in this long. */
export const WORKFLOW_STALL_MINUTES = 20;

/**
 * Reclaim zombie runs — ones stuck in `running` whose Trigger.dev
 * orchestrator crashed (no heartbeat for `WORKFLOW_STALL_MINUTES`). Marks
 * them `failed(STALLED)` so the UI stops showing an eternal spinner and the
 * per-workflow concurrency slot frees up.
 *
 * CRUCIAL: only `status = 'running'` rows are considered. Runs in
 * `needs_approval` are deliberately excluded — they are legitimately parked
 * on a wait token (for up to the token's multi-day timeout) with a
 * necessarily stale heartbeat, and must never be killed for waiting.
 *
 * Each candidate is closed through `finalizeRun` (per-run — the set is
 * normally empty and bounded by crashed orchestrators, not a bulk path), so
 * this terminal path journals `workflow.run.completed` and notifies like
 * every other one; finalizeRun's atomic guard arbitrates concurrent sweeps.
 *
 * Belt-and-suspenders behind the orchestrator's own `onFailure` finalize;
 * run periodically by the jobs maintenance sweep. Returns the count reclaimed.
 */
export const markStalledRuns = async (params?: {
  now?: Date;
}): Promise<number> => {
  const now = params?.now ?? new Date();
  const cutoff = new Date(now.getTime() - WORKFLOW_STALL_MINUTES * 60_000);

  const candidates = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        or(
          lt(workflowRuns.lastHeartbeatAt, cutoff),
          // A run that reached `running` but somehow never stamped a
          // heartbeat (crash right after start) is caught via startedAt.
          and(
            sql`${workflowRuns.lastHeartbeatAt} IS NULL`,
            lt(workflowRuns.startedAt, cutoff),
          ),
        ),
      ),
    );

  let reclaimed = 0;
  for (const candidate of candidates) {
    const { transitioned } = await finalizeRun({
      runId: candidate.id,
      status: "failed",
      error: {
        code: "STALLED",
        message: `No heartbeat for ${WORKFLOW_STALL_MINUTES.toString()} min — the run was reclaimed.`,
      },
      now,
    });
    if (!transitioned) continue;
    reclaimed += 1;
    void sendRunCompletionEmailIfEnabled({ runId: candidate.id }).catch(
      (err: unknown) => {
        console.warn(
          `[workflow-run ${candidate.id}] completion email failed:`,
          err,
        );
      },
    );
  }

  return reclaimed;
};
