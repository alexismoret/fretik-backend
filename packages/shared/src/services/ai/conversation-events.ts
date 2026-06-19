import { redis } from "../../lib/redis";
import { subscribeChannel } from "../../lib/redis-subscriber";

/**
 * A viewer currently looking at a conversation (presence roster entry).
 */
export interface PresenceViewer {
  userId: string;
  name: string;
  image: string | null;
}

/**
 * Per-conversation live event, fanned out to every connected viewer over
 * the `/chatbot/:id/events` SSE channel. Carries the collaborative
 * signals a viewer needs:
 *  - `turn-started` / `turn-ended` → live token fan-out + send gating,
 *  - `message-added` → refetch history (covers human-to-human asides
 *    that don't start an assistant turn),
 *  - `presence` / `typing` → roster + "X is typing…".
 *
 * Cross-replica by design (Redis pub/sub): the streamer and the viewers
 * may be served by different @fretik/ai instances.
 */
export type ConversationEvent =
  | { type: "turn-started"; streamId: string; byUserId: string }
  | { type: "turn-ended"; streamId: string; stopped: boolean }
  | {
      type: "message-added";
      messageId: string;
      role: string;
      authorId: string | null;
    }
  | { type: "presence"; viewers: PresenceViewer[] }
  | { type: "typing"; userId: string; name: string; isTyping: boolean };

const channel = (conversationId: string): string =>
  `fretik-chatbot-events:${conversationId}`;

/** Publish one event to all connected viewers of `conversationId`. */
export const publishConversationEvent = async (
  conversationId: string,
  event: ConversationEvent,
): Promise<void> => {
  await redis.publish(channel(conversationId), JSON.stringify(event));
};

/**
 * Subscribe to a conversation's raw event payloads. The callback gets
 * the JSON string verbatim — the SSE route forwards it as-is and the
 * client parses + types it.
 *
 * Multiplexed over the single shared subscriber connection per replica
 * (`lib/redis-subscriber`) — every viewer of every conversation shares
 * one TCP connection, so the connection count no longer scales with the
 * number of open SSE viewers. Returns an async cleanup to keep the
 * existing handler call sites (`await cleanup()`) unchanged.
 */
export const subscribeConversationEvents = (
  conversationId: string,
  onPayload: (payload: string) => void,
): Promise<() => Promise<void>> => {
  const off = subscribeChannel(channel(conversationId), onPayload);
  const cleanup = (): Promise<void> => {
    off();
    return Promise.resolve();
  };
  return Promise.resolve(cleanup);
};
