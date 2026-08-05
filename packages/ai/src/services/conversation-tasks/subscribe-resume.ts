import { CONVERSATION_TASK_RESUME_CHANNEL } from "@fretik/shared/lib/conversation-task-resume";
import { subscribeChannel } from "@fretik/shared/lib/redis-subscriber";
import { resumePendingConversationTasks } from "./resume-pending";

/**
 * Listen for "this conversation's background work may all be done".
 *
 * Only this service can drive a chatbot turn, but the terminal paths that
 * produce the signal live in three processes (a workflow turn closes here, a
 * cancel in the API, a stall reclaim in jobs) — hence a channel rather than a
 * direct call. Every replica subscribes; the DB claims inside the resume make
 * the duplicate work a no-op.
 *
 * Rides the shared multiplexed subscriber (one connection per replica) and is
 * never released — the subscription lives as long as the process. A signal
 * published in the window before the SUBSCRIBE lands is not delivered, which
 * is fine here: the maintenance sweep re-signals conversations owed a resume.
 */
export const subscribeConversationTaskResumes = (): void => {
  subscribeChannel(CONVERSATION_TASK_RESUME_CHANNEL, (conversationId) => {
    void resumePendingConversationTasks({ conversationId }).catch(
      (err: unknown) => {
        console.warn(
          `[chatbot.task-resume] signal handling failed for ${conversationId}:`,
          err instanceof Error ? err.message : err,
        );
      },
    );
  });
};
