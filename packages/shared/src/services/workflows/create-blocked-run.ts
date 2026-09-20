import db from "../../db";
import { workflowRuns, type Workflow } from "../../db/schema";
import type { WorkflowGateDecision } from "../../schemas/workflows";

/**
 * Record a launch the trigger gate refused.
 *
 * The row is the point. A gate that simply dropped the firing would be a
 * silent veto — the workflow stops running, nothing says so, and the team
 * finds out weeks later from a client. So a refusal produces a run row like
 * any other launch, terminal at `blocked`, carrying the decision that
 * produced it and offering "run anyway".
 *
 * It is DELIBERATELY not a real run: no conversation, no Trigger.dev task, no
 * `startedAt`. Both columns are nullable, so the row costs a single insert
 * and consumes nothing else. Its `triggerPayload` is the same fact sheet a
 * real run would have opened on, which is what lets an override start the run
 * later without re-resolving anything.
 *
 * Idempotent through the partial unique index on
 * `(workflow_id, source_event_id)` — the same identity every event-triggered
 * run has, so a re-swept event cannot produce a second refusal and a refusal
 * can never race a real run for the same firing.
 */
export const createBlockedWorkflowRun = async (params: {
  workflow: Workflow;
  sourceEventId: string;
  triggerPayload: Record<string, unknown>;
  decision: WorkflowGateDecision;
  now?: Date;
}): Promise<{ created: boolean }> => {
  const now = params.now ?? new Date();
  const [inserted] = await db
    .insert(workflowRuns)
    .values({
      organizationId: params.workflow.organizationId,
      teamId: params.workflow.teamId,
      workflowId: params.workflow.id,
      status: "blocked",
      triggerType: "event",
      triggerPayload: params.triggerPayload,
      sourceEventId: params.sourceEventId,
      gateDecision: params.decision,
      finishedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: workflowRuns.id });
  return { created: inserted !== undefined };
};
