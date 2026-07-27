import db from "@fretik/shared/db";
import { redis } from "@fretik/shared/lib/redis";
import {
  clearConversationActiveStream,
  setConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import { publishConversationEvent } from "@fretik/shared/services/ai/conversation-events";
import {
  loadConversationForAgent,
  saveMessage,
} from "@fretik/shared/services/ai/messages";
import { randomUUIDv7 } from "bun";
import {
  getChatbotAgentSet,
  type ChatbotCallOptions,
} from "../../agents/chatbot";
import { runChatbotTurn } from "../../handlers/chatbot";
import {
  resolveChatModelForProfile,
  resolveFlagshipProfileKey,
} from "../../lib/model-registry/resolve";

/** Hidden-message kind — mirrored by the frontend's hidden-kinds filter. */
const CONTINUATION_KIND = "workflow-run-continuation";

/** One resume per run, across racing terminal paths and replicas. */
const resumeLockKey = (runId: string): string => `workflow:resume:${runId}`;

/**
 * Resume the CHAT conversation that launched a test run, once the run is
 * terminal: persist a hidden user-role continuation message (the counterpart
 * of the frontend's `approval-continuation`) and drive one full chatbot turn
 * on it, so the builder analyzes the outcome and iterates or activates —
 * without the user having to say "continue".
 *
 * Fire-and-forget from the run's terminal paths, AFTER
 * `notifySourceConversation` reports it posted the notice (the exactly-once
 * anchor); a Redis NX lock belts-and-braces the check-then-insert race. Every
 * bail is silent by design: the notice is already visible in the chat, so the
 * user can always resume manually — this function must never fail a finalize.
 */
export const resumeSourceConversation = async (params: {
  runId: string;
}): Promise<void> => {
  const { runId } = params;
  const locked = await redis.set(resumeLockKey(runId), "1", "EX", 3600, "NX");
  if (locked !== "OK") return;

  const run = await db.query.workflowRuns.findFirst({
    where: { id: runId },
    columns: {
      sourceConversationId: true,
      workflowId: true,
      status: true,
      outputSummary: true,
      error: true,
      isTest: true,
      triggeredByUserId: true,
    },
  });
  if (!run?.sourceConversationId) return;
  const conversationId = run.sourceConversationId;

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: {
      id: true,
      organizationId: true,
      teamId: true,
      userId: true,
      agentType: true,
      modelProfileKey: true,
    },
  });
  if (!conversation || conversation.agentType !== "chatbot") return;

  const workflow = await db.query.workflows.findFirst({
    where: { id: run.workflowId },
    columns: { name: true },
  });

  // The run outcome, one line — per-task detail stays behind `get_run` so the
  // message never goes stale and stays tiny.
  const outcome =
    run.status === "failed" && run.error
      ? `${run.error.code}: ${run.error.message}`
      : (run.outputSummary?.trim() ?? "");
  const text = [
    `[workflow-run-finished] Test run ${runId} of workflow "${workflow?.name ?? "Workflow"}" ${run.status}.`,
    ...(outcome ? [outcome] : []),
    "FIRST call get_run for the per-task detail — never judge the run from this summary alone. When the conversation holds an example deliverable, download the run's output and diff it against that example. THEN continue the BUILDER loop: fix the playbook with update + run_test, or activate. NEVER redo the run's work yourself in this chat — the deliverable is produced by the run, not here; reproducing it proves nothing about the workflow. The user has not spoken — only ask them when a decision genuinely needs their input.",
  ].join("\n");

  // Claim the turn slot BEFORE persisting the continuation: if a user turn is
  // mid-flight, degrade to notice-only (persisting the message anyway would
  // inject it into that turn's history unannounced).
  const streamId = randomUUIDv7();
  const claimed = await setConversationActiveStream(conversationId, streamId);
  if (!claimed) return;

  try {
    await saveMessage({
      conversationId,
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        kind: CONTINUATION_KIND,
        runId,
        workflowId: run.workflowId,
        status: run.status,
      },
    });

    // Announce like a user POST /stream: every open tab fans in to the
    // resumable buffer. The empty `byUserId` matches no viewer, so nobody
    // skips the fan-in as "their own" turn.
    await publishConversationEvent(conversationId, {
      type: "turn-started",
      streamId,
      byUserId: "",
    });

    const history = await loadConversationForAgent(conversationId, 30);
    const actingUserId = run.triggeredByUserId ?? conversation.userId;
    const callOptions: ChatbotCallOptions = {
      organizationId: conversation.organizationId,
      teamId: conversation.teamId,
      conversationId,
      traceId: streamId,
      ...(actingUserId ? { userId: actingUserId } : {}),
    };
    const { profileKey } = resolveFlagshipProfileKey(
      conversation.modelProfileKey,
    );
    const response = await runChatbotTurn({
      conversationId,
      history,
      callOptions,
      resumableStreamId: streamId,
      logPrefix: "[chatbot.wf-resume]",
      agentSet: getChatbotAgentSet(profileKey),
      modelProfile: resolveChatModelForProfile(profileKey).profile,
    });
    // Drive the turn to completion server-side — nobody holds this Response.
    // The resumable tee + `onFinish` persist, clear the slot, and publish
    // `turn-ended` exactly as a user-facing turn does.
    if (response.body) {
      for await (const chunk of response.body) {
        void chunk;
      }
    }
  } catch (err) {
    console.error(
      `[chatbot.wf-resume] resume failed for run ${runId} (conversation ${conversationId}):`,
      err,
    );
    // The turn's own onFinish never ran — free the slot so the user (and
    // future runs) can start a turn; the notice is already in the chat.
    await clearConversationActiveStream(conversationId, streamId).catch(
      () => undefined,
    );
  }
};
