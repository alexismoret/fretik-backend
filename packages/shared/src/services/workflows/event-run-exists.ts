import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * True when this workflow already has a run for this source event — the
 * event-trigger dedup guard (backs the partial unique index on
 * `(workflow_id, source_event_id)`). Checked before enqueuing AND before
 * creating, so a re-swept event never fans out a second run.
 */
export const eventRunExists = async (params: {
  workflowId: string;
  sourceEventId: string;
}): Promise<boolean> => {
  const [row] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, params.workflowId),
        eq(workflowRuns.sourceEventId, params.sourceEventId),
      ),
    )
    .limit(1);
  return row !== undefined;
};
