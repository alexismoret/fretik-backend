import { and, count, eq, gte } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * How many event-triggered runs a workflow has started since `since` — the
 * per-workflow rate cap that keeps an event storm (a bulk import firing
 * thousands of `document.uploaded`) from launching a matching run for each.
 */
export const countRecentEventRuns = async (params: {
  workflowId: string;
  since: Date;
}): Promise<number> => {
  const [row] = await db
    .select({ count: count() })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, params.workflowId),
        eq(workflowRuns.triggerType, "event"),
        gte(workflowRuns.createdAt, params.since),
      ),
    );
  return row?.count ?? 0;
};
