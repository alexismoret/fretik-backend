import { and, count, eq, ne } from "drizzle-orm";
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
 *
 * `filteredCount` is the workflow's filtered launches, whatever the page
 * shows. The history hides them by default, and a filtered launch is the only
 * place a wrong refusal can be seen ("run anyway"), so the switch that reveals
 * them carries their number rather than hiding that there are any.
 */
export const listWorkflowRuns = async (params: {
  workflowId: string;
  teamId: string;
  params: ParamsList;
  requester?: WorkflowRequester;
  /** Leave out the launches the trigger gate refused. Filtered server-side
   * so the count, and therefore the pagination, stays exact. */
  hideFiltered?: boolean;
}): Promise<{
  count: number;
  data: WorkflowRunResponse[];
  filteredCount: number;
}> => {
  const { workflowId, teamId } = params;
  const { limit, page } = params.params;
  const hideFiltered = params.hideFiltered === true;

  if (params.requester) {
    const visible = await getWorkflowRow({
      id: workflowId,
      teamId,
      requester: params.requester,
    });
    if (!visible) return { count: 0, data: [], filteredCount: 0 };
  }

  const [rows, [total], [filtered]] = await Promise.all([
    db.query.workflowRuns.findMany({
      where: {
        workflowId,
        teamId,
        ...(hideFiltered ? { status: { ne: "filtered" as const } } : {}),
      },
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
          hideFiltered ? ne(workflowRuns.status, "filtered") : undefined,
        ),
      ),
    db
      .select({ count: count() })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, workflowId),
          eq(workflowRuns.teamId, teamId),
          eq(workflowRuns.status, "filtered"),
        ),
      ),
  ]);

  return {
    count: total?.count ?? 0,
    data: rows.map(serializeWorkflowRun),
    filteredCount: filtered?.count ?? 0,
  };
};
