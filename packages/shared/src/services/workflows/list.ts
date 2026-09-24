import type { Principal } from "../../authz/principal";
import db from "../../db";
import type { WorkflowResponse } from "../../schemas/workflows";
import { serializeWorkflow } from "./serialize";
import { workflowAccessWhere } from "./visibility";

/**
 * List a team's workflows, most-recently-updated first. Archived workflows
 * are excluded by default (the card list shows live definitions only).
 * Only the workflows the principal can see (`visibility.ts`).
 */
export const listWorkflows = async (params: {
  teamId: string;
  includeArchived?: boolean;
  principal: Principal;
}): Promise<WorkflowResponse[]> => {
  const rows = await db.query.workflows.findMany({
    where: {
      teamId: params.teamId,
      ...(params.includeArchived ? {} : { status: { ne: "archived" } }),
      ...workflowAccessWhere(params.principal, "view"),
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(serializeWorkflow);
};
