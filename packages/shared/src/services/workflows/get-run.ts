import db from "../../db";
import type { WorkflowRun } from "../../db/schema";
import type { WorkflowRunResponse } from "../../schemas/workflows";
import { serializeWorkflowRun } from "./serialize";
import { workflowVisibilityWhere, type WorkflowRequester } from "./visibility";

/** Raw run row (internal callers: turn handler, finalize, cancel — omit
 * `requester`, system trust). */
export const getWorkflowRunRow = async (params: {
  id: string;
  teamId?: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowRun | undefined> =>
  db.query.workflowRuns.findFirst({
    where: {
      id: params.id,
      ...(params.teamId !== undefined ? { teamId: params.teamId } : {}),
      workflow: workflowVisibilityWhere(params.requester),
    },
  });

/** Team-scoped run DTO for the API. `requester` also hides a run whose
 * parent workflow is private to someone else (admins see all). */
export const getWorkflowRun = async (params: {
  id: string;
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowRunResponse | undefined> => {
  const row = await getWorkflowRunRow(params);
  return row ? serializeWorkflowRun(row) : undefined;
};
