import db from "../../db";
import { publishConversationTaskResume } from "../../lib/conversation-task-resume";
import { completeConversationTask } from "../conversation-tasks/complete";
import { consumeConversationTasks } from "../conversation-tasks/consume";
import { terminalTaskStatusOfRun } from "../conversation-tasks/kinds";
import { requestSubAgentStop } from "../conversation-tasks/request-sub-agent-stop";
import { labelGateOnRunOutcome } from "./label-gate-outcome";
import { notifySourceConversation } from "./notify-source-conversation";

/**
 * The single seam every terminal run path goes through to inform the chat
 * that launched it.
 *
 * Three effects on the chat, each with its own exactly-once anchor so racing
 * paths (a turn-close and a cancel landing together, a sweep and an
 * orchestrator finalize) never double up — and two more that are idempotent
 * by construction, the gate label and the run's own sub-agents:
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
    columns: {
      status: true,
      conversationId: true,
      sourceConversationId: true,
      teamId: true,
      workflowId: true,
      sourceEventId: true,
      gateDecision: true,
    },
  });
  const terminal = run ? terminalTaskStatusOfRun(run.status) : null;
  if (!run || terminal === null) return;

  // 4. The trigger gate's decision learns how the run ended. Not anchored:
  // the label write only fills an empty label, so a second pass is a no-op.
  await labelGateOnRunOutcome(run);

  const { conversationId } = await completeConversationTask({
    kind: "workflow_run",
    ref: params.runId,
    status: terminal,
  });

  await notifySourceConversation({ runId: params.runId });

  if (conversationId) await publishConversationTaskResume(conversationId);

  // 5. The run's own sub-agents: nobody is left to read their reports. The
  // running ones are asked to stop and settle quietly; the settled ones are
  // consumed. Their conversation is the run's, never a chat's.
  if (run.conversationId !== null) {
    await requestSubAgentStop({
      conversationId: run.conversationId,
      by: "parent",
      all: true,
    });
    await consumeConversationTasks({
      conversationId: run.conversationId,
      kind: "sub_agent",
    });
  }
};
