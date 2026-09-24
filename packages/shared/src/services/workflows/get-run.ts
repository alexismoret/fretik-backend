import type { Principal } from "../../authz/principal";
import db from "../../db";
import type { WorkflowRun } from "../../db/schema";
import type { WorkflowRunResponse } from "../../schemas/workflows";
import { serializeWorkflowRun } from "./serialize";
import { workflowAccessWhere } from "./visibility";

/**
 * Raw run row, if the principal reaches its workflow. Internal callers (the
 * turn handler, finalize, cancel) pass a system principal — and a team when
 * they have one: without it the lookup is by id across teams, which only a
 * caller holding the run's own id from a trusted source may do.
 */
export const getWorkflowRunRow = async (params: {
  id: string;
  teamId?: string;
  principal: Principal;
}): Promise<WorkflowRun | undefined> =>
  db.query.workflowRuns.findFirst({
    where: {
      id: params.id,
      ...(params.teamId !== undefined ? { teamId: params.teamId } : {}),
      workflow: workflowAccessWhere(params.principal, "view"),
    },
  });

/** Team-scoped run DTO for the API, if the principal reaches its workflow. */
export const getWorkflowRun = async (params: {
  id: string;
  teamId: string;
  principal: Principal;
}): Promise<WorkflowRunResponse | undefined> => {
  const row = await getWorkflowRunRow(params);
  return row ? serializeWorkflowRun(row) : undefined;
};
