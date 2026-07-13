import db from "../../db";
import type { WorkflowActiveRun } from "../../schemas/workflows";
import { workflowVisibilityWhere, type WorkflowRequester } from "./visibility";

/**
 * Every NON-terminal run of a team (queued/running/needs_approval), newest
 * first. Powers the live pulse on the workflow card list: the index page
 * polls this one cheap, `(teamId, status)`-indexed query and joins the rows
 * to its cards by `workflowId` — no per-card run fetch, no Trigger token.
 * `requester` hides runs of a private workflow from anyone but its owner
 * (admins see all) so a teammate's private run never pulses on the hub.
 */
export const listActiveWorkflowRuns = async (params: {
  teamId: string;
  requester?: WorkflowRequester;
}): Promise<WorkflowActiveRun[]> => {
  const rows = await db.query.workflowRuns.findMany({
    where: {
      teamId: params.teamId,
      status: { in: ["queued", "running", "needs_approval"] },
      workflow: workflowVisibilityWhere(params.requester),
    },
    orderBy: { createdAt: "desc" },
    columns: {
      id: true,
      workflowId: true,
      status: true,
      isTest: true,
      startedAt: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    runId: row.id,
    workflowId: row.workflowId,
    status: row.status,
    isTest: row.isTest,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  }));
};
