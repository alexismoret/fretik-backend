import db from "../../db";
import type { Workflow } from "../../db/schema";
import type { WorkflowResponse } from "../../schemas/workflows";
import { serializeWorkflow } from "./serialize";
import { workflowVisibilityWhere, type WorkflowRequester } from "./visibility";

/**
 * Fetch one workflow row, team-scoped. `requester` also restricts a private
 * workflow to its owner (admins/internal callers see every workflow) —
 * internal callers (run creation, activation, the turn executor) omit it on
 * purpose, since they already resolved the workflow through a trusted path
 * (the trigger, the run row) and must see it regardless of who owns it.
 */
export const getWorkflowRow = async (params: {
  id: string;
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<Workflow | undefined> =>
  db.query.workflows.findFirst({
    where: {
      id: params.id,
      teamId: params.teamId,
      ...workflowVisibilityWhere(params.requester),
    },
  });

/** Team-scoped workflow DTO for the API. `undefined` = not found / not visible. */
export const getWorkflow = async (params: {
  id: string;
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse | undefined> => {
  const row = await getWorkflowRow(params);
  return row ? serializeWorkflow(row) : undefined;
};
