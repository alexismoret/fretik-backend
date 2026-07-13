import { and, count, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import type { ParamsList } from "../../schemas/common/params";
import type { WorkflowRunResponse } from "../../schemas/workflows";
import { getWorkflowRow } from "./get";
import { serializeWorkflowRun } from "./serialize";
import type { WorkflowRequester } from "./visibility";

/**
 * List a workflow's runs, newest first, paginated. Team-scoped. Returns the
 * `{ count, data }` envelope (`responseListSchema`) so the frontend can drive
 * a `UPagination` from the exact total. Reuses `ParamsList` (limit/page) for
 * the query params — `search` is unused (runs have no searchable title).
 * `requester` gates on the PARENT workflow's visibility — not visible (a
 * private workflow owned by someone else) → empty page, matching the
 * existing "no such workflow" soft-empty shape rather than throwing.
 */
export const listWorkflowRuns = async (params: {
  workflowId: string;
  teamId: string;
  params: ParamsList;
  requester?: WorkflowRequester;
}): Promise<{ count: number; data: WorkflowRunResponse[] }> => {
  const { workflowId, teamId } = params;
  const { limit, page } = params.params;

  if (params.requester) {
    const visible = await getWorkflowRow({
      id: workflowId,
      teamId,
      requester: params.requester,
    });
    if (!visible) return { count: 0, data: [] };
  }

  const [rows, [total]] = await Promise.all([
    db.query.workflowRuns.findMany({
      where: { workflowId, teamId },
      orderBy: { createdAt: "desc" },
      limit,
      offset: page * limit,
    }),
    db
      .select({ count: count() })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, workflowId),
          eq(workflowRuns.teamId, teamId),
        ),
      ),
  ]);

  return {
    count: total?.count ?? 0,
    data: rows.map(serializeWorkflowRun),
  };
};
