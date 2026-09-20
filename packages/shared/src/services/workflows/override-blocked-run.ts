import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../lib/errors";
import type { WorkflowRunResponse } from "../../schemas/workflows";
import { createWorkflowRun } from "./create-run";
import { getWorkflowRow } from "./get";
import type { WorkflowRequester } from "./visibility";

/**
 * "Run anyway" — start a launch the gate refused.
 *
 * This is the feature's correction mechanism AND its measurement, in one
 * gesture. A person looking at a blocked row and deciding it should have run
 * is the only signal that exists for a gate false negative: the model was
 * confidently wrong, nothing else would ever have said so, and the click says
 * it while also giving them what they wanted.
 *
 * The blocked row is CONSUMED rather than left beside the new run. It holds
 * the `(workflow_id, source_event_id)` identity that dedups event runs, so
 * leaving it would make the real run impossible to create under the same
 * identity — and two rows for one firing is exactly the confusion the single
 * identity exists to prevent. The decision survives on the new run, stamped
 * `overridden` with who did it and when, so the record of the refusal is not
 * lost; it is attached to the launch that overruled it.
 */
export const overrideBlockedWorkflowRun = async (params: {
  runId: string;
  teamId: string;
  userId: string;
  /** Restricts a private workflow's blocked run to its owner, exactly as it
   * restricts that workflow's normal runs. */
  requester?: WorkflowRequester;
}): Promise<WorkflowRunResponse> => {
  const blocked = await db.query.workflowRuns.findFirst({
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
  if (!blocked) return throwHttpError(404, notFound("Run"));
  if (blocked.status !== "blocked") {
    return throwHttpError(
      403,
      forbidden("Only a run the trigger gate blocked can be started anyway."),
    );
  }

  const workflow = await getWorkflowRow({
    id: blocked.workflowId,
    teamId: params.teamId,
    ...(params.requester !== undefined ? { requester: params.requester } : {}),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow"));

  // Free the dedup identity first, and only for a row still `blocked` — two
  // people pressing the button together must produce one run, and the loser
  // matches zero rows here rather than creating a second.
  const [claimed] = await db
    .delete(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, params.runId),
        eq(workflowRuns.status, "blocked"),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (!claimed) {
    return throwHttpError(403, forbidden("This run has already been started."));
  }

  return createWorkflowRun({
    workflow,
    triggerType: "event",
    triggerPayload: blocked.triggerPayload,
    triggeredByUserId: params.userId,
    ...(blocked.sourceEventId !== null
      ? { sourceEventId: blocked.sourceEventId }
      : {}),
    gateDecision: {
      ...(blocked.gateDecision ?? {
        outcome: "blocked",
        decidedAt: new Date().toISOString(),
      }),
      outcome: "overridden",
      overriddenAt: new Date().toISOString(),
      overriddenByUserId: params.userId,
    },
  });
};
