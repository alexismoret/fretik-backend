import { redis } from "./redis";

/**
 * Redis pub/sub channel carrying "this conversation may be resumable now" to
 * the AI service, which owns `runChatbotTurn` and is the only process able to
 * drive a turn. Mirrors the workflow abort channel.
 *
 * Why pub/sub rather than an HTTP call: the hottest publisher (the workflow
 * turn-close path) runs INSIDE the AI process, which never dials itself
 * (`lib/ai-service.ts` — AI_SERVICE_URL is absent from its env), while the
 * cancel and stall paths run in the API and jobs processes. One channel serves
 * all three without a second transport.
 *
 * Delivery is best-effort by design: exactly-once comes from the DB claim on
 * `conversation_background_tasks.consumed_at`, not from this message. A signal
 * lost to a restart is picked up by the turn-end drain or the 5-minute sweep.
 */
export const CONVERSATION_TASK_RESUME_CHANNEL =
  "fretik-conversation-task-resume";

/** Signal that a conversation's background tasks may all be terminal. */
export const publishConversationTaskResume = async (
  conversationId: string,
): Promise<void> => {
  await redis.publish(CONVERSATION_TASK_RESUME_CHANNEL, conversationId);
};
