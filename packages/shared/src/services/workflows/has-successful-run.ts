import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * True when the workflow has at least one run that reached `succeeded`.
 * The activation gate: the builder must prove a workflow works (a green
 * test run) before it goes active, unless the user explicitly overrides.
 *
 * `not_applicable` deliberately does NOT count. A run that skipped every task
 * proves the executor read its input and declined it — which says nothing
 * about whether the playbook can do the work, and that is the only thing this
 * gate is asking.
 */
export const hasSuccessfulRun = async (params: {
  workflowId: string;
  teamId: string;
}): Promise<boolean> => {
  const [row] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, params.workflowId),
        eq(workflowRuns.teamId, params.teamId),
        eq(workflowRuns.status, "succeeded"),
      ),
    )
    .limit(1);
  return row !== undefined;
};
