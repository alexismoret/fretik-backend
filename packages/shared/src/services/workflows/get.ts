import type { Principal } from "../../authz/principal";
import db from "../../db";
import type { Workflow } from "../../db/schema";
import type { AccessLevel } from "../../schemas/access";
import type { WorkflowResponse } from "../../schemas/workflows";
import { serializeWorkflow } from "./serialize";
import { workflowAccessWhere } from "./visibility";

/**
 * Fetch one workflow row of its team, if the principal reaches it at `level`
 * (`view` by default). Internal callers (run creation, activation, the turn
 * executor) pass a system principal: they resolved the workflow through a
 * trusted path — the trigger, the run row — and act for nobody.
 */
export const getWorkflowRow = async (params: {
  id: string;
  teamId: string;
  principal: Principal;
  level?: AccessLevel;
}): Promise<Workflow | undefined> =>
  db.query.workflows.findFirst({
    where: {
      id: params.id,
      teamId: params.teamId,
      ...workflowAccessWhere(params.principal, params.level ?? "view"),
    },
  });

/** Team-scoped workflow DTO for the API. `undefined` = not found / not visible. */
export const getWorkflow = async (params: {
  id: string;
  teamId: string;
  principal: Principal;
  level?: AccessLevel;
}): Promise<WorkflowResponse | undefined> => {
  const row = await getWorkflowRow(params);
  return row ? serializeWorkflow(row) : undefined;
};
