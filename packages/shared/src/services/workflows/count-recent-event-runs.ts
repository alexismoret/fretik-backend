import { and, count, eq, gte, ne } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * How many event-triggered runs a workflow has started since `since` — the
 * per-workflow rate cap that keeps an event storm (a bulk import firing
 * thousands of `document.uploaded`) from launching a matching run for each.
 *
 * `filtered` rows are EXCLUDED, and getting this wrong would have turned the
 * trigger gate against the workflows it protects: a refusal writes a row with
 * `trigger_type = 'event'` like any launch, so a broad trigger with a good
 * criterion — the exact case the gate exists for — would have accumulated
 * thousands of refusals an hour and auto-paused itself with `runaway:<cap>`.
 * The cap counts what a workflow SPENT, and a refused launch spent nothing.
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
        ne(workflowRuns.status, "filtered"),
        gte(workflowRuns.createdAt, params.since),
      ),
    );
  return row?.count ?? 0;
};
