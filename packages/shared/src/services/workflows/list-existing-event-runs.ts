import { and, inArray } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * Batch sibling of `eventRunExists` — ONE query answering "which of this
 * sweep's matched (workflow, source event) pairs already have a run", instead
 * of one round trip per pair (N events × M workflows melted the sweep).
 * Backed by the partial unique index on `(workflow_id, source_event_id)`;
 * the `IN` lists imply `source_event_id IS NOT NULL`, so the partial index
 * applies. Returns keys `${workflowId}:${sourceEventId}`.
 */
export const listExistingEventRuns = async (params: {
  workflowIds: string[];
  sourceEventIds: string[];
}): Promise<Set<string>> => {
  if (params.workflowIds.length === 0 || params.sourceEventIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({
      workflowId: workflowRuns.workflowId,
      sourceEventId: workflowRuns.sourceEventId,
    })
    .from(workflowRuns)
    .where(
      and(
        inArray(workflowRuns.workflowId, params.workflowIds),
        inArray(workflowRuns.sourceEventId, params.sourceEventIds),
      ),
    );
  return new Set(rows.map((r) => `${r.workflowId}:${r.sourceEventId ?? ""}`));
};
