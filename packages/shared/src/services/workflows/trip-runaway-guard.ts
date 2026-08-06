import db from "../../db";
import { pauseWorkflow } from "./pause";

/** Reason prefix stamped on `workflows.pausedReason`; the UI splits on ":". */
export const RUNAWAY_REASON_PREFIX = "runaway";

/**
 * Runaway guard: auto-pause a workflow whose event trigger created more than
 * `cap` runs in the last hour. The counterpart of the circuit breaker for
 * VOLUME instead of failures — a legit bulk upload stays under the (high)
 * cap, so tripping it means something upstream is spraying events (a
 * misconfigured connector, an external system in a loop). Pausing is loud
 * (`pausedReason 'runaway:<cap>'` renders as auto-stopped in the UI) and
 * reversible: re-activating clears the reason.
 *
 * The queued event backlog dies with the pause: `deactivateWorkflow` (behind
 * `pauseWorkflow`) cancels queued event runs on EVERY deactivation path — a
 * storm's queued runs are as suspect as the ones that tripped the guard.
 *
 * Idempotent across the create worker's concurrent jobs: only the first
 * tripper sees `status 'active'` and transitions; the rest no-op.
 */
export const tripRunawayGuard = async (params: {
  workflowId: string;
  teamId: string;
  cap: number;
}): Promise<void> => {
  const workflow = await db.query.workflows.findFirst({
    where: { id: params.workflowId },
    columns: { status: true },
  });
  if (!workflow || workflow.status !== "active") return;

  await pauseWorkflow({
    id: params.workflowId,
    teamId: params.teamId,
    reason: `${RUNAWAY_REASON_PREFIX}:${String(params.cap)}`,
  });
  console.warn(
    `[runaway-guard] auto-paused workflow ${params.workflowId} — more than ${String(params.cap)} event runs created in the last hour`,
  );
};
