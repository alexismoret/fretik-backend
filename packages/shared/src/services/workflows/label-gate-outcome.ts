import type { WorkflowRunStatus } from "../../schemas/workflows";
import { labelDecisions } from "../decisions/journal";

/**
 * What a finished run says about the gate question "did this firing meet the
 * workflow's condition?".
 *
 * Only two endings answer it. `succeeded` means the run found its work, so
 * the condition was met. `not_applicable` means the agent read the input and
 * found nothing for it — the exact case the gate exists to catch, and the
 * label that says the gate let one through. A failure or a cancellation says
 * nothing about the input, so it labels nothing.
 */
export const gateLabelForRunStatus = (
  status: WorkflowRunStatus,
): "true" | "false" | null => {
  if (status === "succeeded") return "true";
  if (status === "not_applicable") return "false";
  return null;
};

/**
 * Label the gate decision behind a finished event run. An inference, so it
 * fills an empty label and never replaces one a person gave ("run anyway").
 * Best-effort: never throws.
 */
export const labelGateOnRunOutcome = async (run: {
  teamId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  sourceEventId: string | null;
  gateDecision: unknown;
}): Promise<void> => {
  const label = gateLabelForRunStatus(run.status);
  if (label === null || run.sourceEventId === null) return;
  // An ungated run has nothing to label, and skipping it saves the write.
  if (run.gateDecision === null) return;
  await labelDecisions({
    teamId: run.teamId,
    point: "workflow.gate",
    subjectId: run.sourceEventId,
    targetId: run.workflowId,
    label,
    source: "run_outcome",
  });
};
