import db from "../../db";
import type { WorkflowAutonomy } from "../../schemas/workflows";

/**
 * Resolve the write-autonomy mode governing a conversation, when that
 * conversation belongs to a workflow run. `null` = a regular chat
 * conversation → the caller applies the normal HITL approval flow.
 *
 * The seam the external-apps plan dispatch consults so a run's autonomy is
 * enforced SERVER-side (read_only rejects plans, autonomous executes them
 * without pausing) — never just a prompt suggestion.
 */
export const getWorkflowAutonomyForConversation = async (
  conversationId: string,
): Promise<WorkflowAutonomy | null> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { conversationId },
    columns: { workflowId: true },
  });
  if (!run) return null;
  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { autonomy: true },
  });
  return workflow?.autonomy ?? null;
};
