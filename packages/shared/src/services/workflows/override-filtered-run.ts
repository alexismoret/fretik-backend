import db from "../../db";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";
import type {
  WorkflowGateDecision,
  WorkflowRunResponse,
} from "../../schemas/workflows";
import { labelDecisions } from "../decisions/journal";
import { createWorkflowRun } from "./create-run";
import { getWorkflowRow } from "./get";
import type { WorkflowRequester } from "./visibility";

/**
 * "Run anyway" — start a launch the gate refused.
 *
 * This is the feature's correction mechanism AND its measurement, in one
 * gesture. A person looking at a filtered row and deciding it should have run
 * is the only signal that exists for a gate false negative: the model was
 * confidently wrong, nothing else would ever have said so, and the click says
 * it while also giving them what they wanted.
 *
 * The filtered row is REPLACED rather than left beside the new run. It holds
 * the `(workflow_id, source_event_id)` identity that dedups event runs, and
 * two rows for one firing is exactly the confusion that identity prevents.
 * The replacement is atomic — `createWorkflowRun` deletes the filtered row in
 * the same transaction that inserts the run — so a failed launch leaves the
 * refusal in place to retry, instead of losing both. The decision survives on
 * the new run, stamped `overridden` with who and when.
 */
export const overrideFilteredWorkflowRun = async (params: {
  runId: string;
  teamId: string;
  userId: string;
  /** Restricts a private workflow's filtered run to its owner, exactly as it
   * restricts that workflow's normal runs. */
  requester?: WorkflowRequester;
}): Promise<WorkflowRunResponse> => {
  const filtered = await db.query.workflowRuns.findFirst({
    where: { id: params.runId, teamId: params.teamId },
    columns: {
      id: true,
      status: true,
      workflowId: true,
      sourceEventId: true,
      triggerPayload: true,
      gateDecision: true,
    },
  });
  if (!filtered) return throwHttpError(404, notFound("Run"));
  if (filtered.status !== "filtered") {
    return throwHttpError(
      403,
      forbidden(
        "Only a run the trigger gate filtered out can be started anyway.",
      ),
    );
  }

  const workflow = await getWorkflowRow({
    id: filtered.workflowId,
    teamId: params.teamId,
    ...(params.requester !== undefined ? { requester: params.requester } : {}),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow"));

  const now = new Date().toISOString();
  const decision: WorkflowGateDecision = {
    ...(filtered.gateDecision ?? { outcome: "filtered", decidedAt: now }),
    outcome: "overridden",
    overriddenAt: now,
    overriddenByUserId: params.userId,
  };

  const run = await createWorkflowRun({
    workflow,
    triggerType: "event",
    triggerPayload: filtered.triggerPayload,
    triggeredByUserId: params.userId,
    ...(filtered.sourceEventId !== null
      ? { sourceEventId: filtered.sourceEventId }
      : {}),
    gateDecision: decision,
    replacesFilteredRunId: filtered.id,
  });

  // The person just answered the gate's question: this firing DID meet the
  // condition. An explicit act, so it outranks whatever the run later does.
  if (filtered.sourceEventId !== null) {
    await labelDecisions({
      teamId: params.teamId,
      point: "workflow.gate",
      subjectId: filtered.sourceEventId,
      targetId: filtered.workflowId,
      label: "true",
      source: "run_anyway",
      userId: params.userId,
    });
  }
  return run;
};
