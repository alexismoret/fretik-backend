import db from "../../db";
import { publishConversationTaskResume } from "../../lib/conversation-task-resume";
import { completeConversationTask } from "../conversation-tasks/complete";
import { notifySourceConversation } from "./notify-source-conversation";

/**
 * The single seam every terminal run path goes through to inform the chat
 * that launched it.
 *
 * Three effects, each with its own exactly-once anchor so racing paths (a
 * turn-close and a cancel landing together, a sweep and an orchestrator
 * finalize) never double up:
 *  1. the wait registry is settled (`status = 'pending'` guard in the UPDATE);
 *  2. the visible completion notice is posted (dedup on the message metadata);
 *  3. a resume is signalled — the AI service decides whether the conversation
 *     is actually owed one, since only IT knows if the run was the last thing
 *     the conversation was waiting on.
 *
 * Callers are the turn-close handler, the orchestrator's `/finalize` route,
 * cancel-run, and the stall sweeper — the last two previously did none of
 * this, leaving a chat that launched a run hanging forever when the run was
 * canceled while queued or reclaimed as stalled.
 *
 * Fire-and-forget: never throws, never blocks a finalize.
 */
export const onWorkflowRunTerminal = async (params: {
  runId: string;
}): Promise<void> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: params.runId },
    columns: { status: true, sourceConversationId: true },
  });
  if (
    run?.status !== "succeeded" &&
    run?.status !== "failed" &&
    run?.status !== "canceled"
  ) {
    return;
  }

  const { conversationId } = await completeConversationTask({
    kind: "workflow_run",
    ref: params.runId,
    status: run.status,
  });

  await notifySourceConversation({ runId: params.runId });

  if (conversationId) await publishConversationTaskResume(conversationId);
};
