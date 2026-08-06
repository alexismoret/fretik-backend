import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { cancelWorkflowTriggerRun } from "../../lib/trigger-client";
import { finalizeRun } from "./finalize-run";

/** Bounded fan-out: each cancel is one Trigger.dev network call. */
const CANCEL_PARALLELISM = 5;

/**
 * Cancel every still-`queued` EVENT run of a workflow — the burst kill
 * switch. Called when the workflow stops being trustworthy while a backlog
 * waits in the Trigger.dev queue: the circuit breaker tripped, the runaway
 * guard fired, or the user paused it (Pause = "stop the flood").
 *
 * Only `queued` + `triggerType 'event'` rows qualify: running /
 * needs_approval runs keep their normal lifecycle, and queued manual / test /
 * form runs are user-initiated (seconds from running) so they are left alone.
 *
 * Per-run `finalizeRun` (not a bulk UPDATE) on purpose: each close must
 * journal `workflow.run.completed` and win/lose its own atomic transition
 * race against a run that just started. The Trigger cancel is best-effort —
 * if it fails, the AI turn handler answers terminally on turn 1 because the
 * run row is already terminal, so the run still dies cheaply.
 */
export const cancelQueuedEventRuns = async (params: {
  workflowId: string;
  teamId: string;
}): Promise<number> => {
  const candidates = await db
    .select({ id: workflowRuns.id, triggerRunId: workflowRuns.triggerRunId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, params.workflowId),
        eq(workflowRuns.teamId, params.teamId),
        eq(workflowRuns.status, "queued"),
        eq(workflowRuns.triggerType, "event"),
      ),
    );

  let canceled = 0;
  for (let i = 0; i < candidates.length; i += CANCEL_PARALLELISM) {
    const chunk = candidates.slice(i, i + CANCEL_PARALLELISM);
    const results = await Promise.all(
      chunk.map(async (run) => {
        if (run.triggerRunId) {
          await cancelWorkflowTriggerRun(run.triggerRunId).catch(
            (error: unknown) => {
              console.warn(
                `[workflows.cancel-queued] runs.cancel failed for ${run.triggerRunId ?? "?"}:`,
                error instanceof Error ? error.message : error,
              );
            },
          );
        }
        const { transitioned } = await finalizeRun({
          runId: run.id,
          status: "canceled",
          error: {
            code: "CANCELED",
            message: "Canceled while queued — the workflow was paused.",
          },
        });
        return transitioned;
      }),
    );
    canceled += results.filter(Boolean).length;
  }
  return canceled;
};
