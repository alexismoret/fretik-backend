import db from "@fretik/shared/db";
import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import {
  clearConversationActiveStream,
  setConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import { publishConversationEvent } from "@fretik/shared/services/ai/conversation-events";
import {
  loadConversationForAgent,
  saveMessage,
} from "@fretik/shared/services/ai/messages";
import {
  claimCompletedConversationTasks,
  releaseClaimedConversationTasks,
} from "@fretik/shared/services/conversation-tasks/claim-completed";
import { hasResumableConversationTasks } from "@fretik/shared/services/conversation-tasks/list";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
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
import {
  buildWorkflowRunContinuation,
  workflowRunDoctrine,
} from "./workflow-run-continuation";

/** Hidden-message kind — mirrored by the frontend's hidden-kinds filter. */
const CONTINUATION_KIND = "background-task-continuation";

const LOG_PREFIX = "[chatbot.task-resume]";

/**
 * Wake a conversation whose background work has all finished.
 *
 * The agent launches something that outlives its turn (a workflow run today),
 * keeps working, ends the turn. Each launch is a row in
 * `conversation_background_tasks`; each outcome settles one. When the LAST one
 * settles, this drives one full chatbot turn on a hidden continuation message
 * carrying every outcome at once — so a conversation that launched three runs
 * is resumed once, with three results, not three times.
 *
 * Called from three places, all of which may fire for the same batch: the
 * Redis resume signal (the normal path), the end of any turn (covers a task
 * that finished while the conversation was busy), and the maintenance sweep
 * (covers a signal lost to a restart). Exactly-once comes from two claims —
 * the turn slot CAS and the task-row claim — so the extra callers are free.
 *
 * Every bail is silent by design: the per-run notice is already visible in the
 * chat, so the user can always continue manually. This must never fail a
 * finalize or a turn.
 */
export const resumePendingConversationTasks = async (params: {
  conversationId: string;
}): Promise<void> =>
  // Detach from the caller's tracing context. This runs from a run's terminal
  // path or another turn's onFinish, and OTel propagates context across async
  // continuations — so the chat turn nested under the caller's span: one
  // merged trace, relabelled with the wrong session, the turn's cost billed to
  // the wrong unit of work. Two units of work, two traces.
  context.with(ROOT_CONTEXT, () => runResume(params));

const runResume = async (params: { conversationId: string }): Promise<void> => {
  const { conversationId } = params;

  // Cheap pre-check ahead of the claiming UPDATE, which is the authority.
  if (!(await hasResumableConversationTasks(conversationId))) return;

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

  // Claim the turn slot BEFORE claiming the tasks: if a user turn is in
  // flight, leave the rows unconsumed — that turn's own `onFinish` calls us
  // back, so the resume is deferred, never dropped.
  const streamId = randomUUIDv7();
  const claimedSlot = await setConversationActiveStream(
    conversationId,
    streamId,
  );
  if (!claimedSlot) return;

  let claimed: ConversationBackgroundTask[] = [];
  try {
    claimed = await claimCompletedConversationTasks(conversationId);
    if (claimed.length === 0) {
      await clearConversationActiveStream(conversationId, streamId);
      return;
    }

    const built = await buildContinuation(claimed);
    if (!built) {
      await clearConversationActiveStream(conversationId, streamId);
      return;
    }

    await saveMessage({
      conversationId,
      role: "user",
      parts: [{ type: "text", text: built.text }],
      metadata: {
        kind: CONTINUATION_KIND,
        taskIds: claimed.map((task) => task.id),
        refs: claimed.map((task) => task.ref),
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
    const actingUserId = built.actingUserId ?? conversation.userId;
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
      logPrefix: LOG_PREFIX,
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
      `${LOG_PREFIX} resume failed for conversation ${conversationId}:`,
      err,
    );
    // The turn's own onFinish never ran — free the slot, and hand the tasks
    // back so the sweep retries them rather than losing the outcomes.
    await clearConversationActiveStream(conversationId, streamId).catch(
      () => undefined,
    );
    await releaseClaimedConversationTasks(claimed.map((task) => task.id)).catch(
      () => undefined,
    );
  }
};

/**
 * Assemble one continuation message from a whole batch: what came back, then
 * how to deal with it. Returns null when nothing in the batch could be
 * described (every underlying row vanished).
 */
const buildContinuation = async (
  tasks: ConversationBackgroundTask[],
): Promise<{ text: string; actingUserId: string | null } | null> => {
  const lines: string[] = [];
  let hasTest = false;
  let hasReal = false;
  let actingUserId: string | null = null;

  for (const task of tasks) {
    const built = await buildWorkflowRunContinuation(task);
    if (!built) continue;
    lines.push(built.line);
    if (built.isTest) hasTest = true;
    else hasReal = true;
    actingUserId ??= built.triggeredByUserId;
  }
  if (lines.length === 0) return null;

  const header =
    lines.length === 1
      ? `[background-task-finished] ${lines[0] ?? ""}`
      : [
          `[background-tasks-finished] ${lines.length.toString()} runs you launched have finished:`,
          ...lines.map((line) => `- ${line}`),
        ].join("\n");

  return {
    text: [header, ...workflowRunDoctrine({ hasTest, hasReal })].join("\n"),
    actingUserId,
  };
};
