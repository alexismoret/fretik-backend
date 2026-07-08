import db from "../../db";
import type { WorkflowResponse } from "../../schemas/workflows";
import { serializeWorkflow } from "./serialize";
import { workflowVisibilityWhere, type WorkflowRequester } from "./visibility";

/**
 * List a team's workflows, most-recently-updated first. Archived workflows
 * are excluded by default (the card list shows live definitions only).
 * `requester` restricts private (user-scoped) workflows to their owner —
 * admins and internal callers (omitted `requester`) see every workflow.
 */
export const listWorkflows = async (params: {
  teamId: string;
  includeArchived?: boolean;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse[]> => {
  const rows = await db.query.workflows.findMany({
    where: {
      teamId: params.teamId,
      ...(params.includeArchived ? {} : { status: { ne: "archived" } }),
      ...workflowVisibilityWhere(params.requester),
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(serializeWorkflow);
};
