import type { Principal } from "../../authz/principal";
import { cancelWorkflowTriggerRun } from "../../lib/trigger-client";
import { publishWorkflowAbort } from "../../lib/workflow-abort";
import {
  isTerminalRunStatus,
  type WorkflowRunResponse,
} from "../../schemas/workflows";
import { finalizeRun } from "./finalize-run";
import { getWorkflowRun, getWorkflowRunRow } from "./get-run";
import { onWorkflowRunTerminal } from "./on-run-terminal";

/**
 * Stop a run (the Stop button). Best-effort cancels the Trigger.dev run
 * when one is actually running, publishes a mid-turn abort so an in-flight
 * turn truncates now, then closes the run `canceled`. Idempotent — a
 * terminal run is returned unchanged.
 * Returns `undefined` when the run doesn't exist or its workflow is not
 * visible to the principal. Stopping a run is operating the workflow: callers
 * check `use` on it first (a restricted workflow's run is its owner's).
 */
export const cancelWorkflowRun = async (params: {
  runId: string;
  teamId: string;
  principal: Principal;
}): Promise<WorkflowRunResponse | undefined> => {
  const run = await getWorkflowRunRow({
    id: params.runId,
    teamId: params.teamId,
    principal: params.principal,
  });
  if (!run) return undefined;
  if (isTerminalRunStatus(run.status)) {
    return getWorkflowRun({
      id: params.runId,
      teamId: params.teamId,
      principal: params.principal,
    });
  }

  // A parked run has NO live orchestrator — it exited at the park rather
  // than hold the workflow's concurrency slot — so `triggerRunId` is either
  // null or points at an already-completed Trigger run. Cancelling that is a
  // guaranteed error in the log for nothing; the finalize below is what
  // stops the run.
  if (run.triggerRunId && run.status !== "needs_approval") {
    // Never let a Trigger API hiccup block the local cancel — the abort
    // publish + finalize below still stop the run from the user's view.
    await cancelWorkflowTriggerRun(run.triggerRunId).catch((error: unknown) => {
      console.warn(
        `[workflows.cancel] runs.cancel failed for ${run.triggerRunId ?? "?"}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }
  await publishWorkflowAbort(params.runId);
  await finalizeRun({
    runId: params.runId,
    status: "canceled",
    error: { code: "CANCELED", message: "Stopped by a user." },
  });

  // Tell the launching chat. A run canceled while it was still queued or
  // parked on an approval has no in-flight turn to carry the news, so without
  // this the conversation waited on it forever.
  await onWorkflowRunTerminal({ runId: params.runId }).catch(
    (error: unknown) => {
      console.warn(
        `[workflows.cancel] source-conversation notice failed for ${params.runId}:`,
        error instanceof Error ? error.message : error,
      );
    },
  );

  return getWorkflowRun({
    id: params.runId,
    teamId: params.teamId,
    principal: params.principal,
  });
};
