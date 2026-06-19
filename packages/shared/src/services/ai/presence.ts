import { redis } from "../../lib/redis";
import {
  type PresenceViewer,
  publishConversationEvent,
} from "./conversation-events";

/**
 * Ephemeral, Redis-only presence + typing for collaborative conversations.
 * Each viewer writes a short-TTL key while their `/events` stream is open
 * and re-`mark`s on a ~10s heartbeat; the TTL self-heals an unclean tab
 * close (no explicit leave needed). Typing is fire-and-forget (no storage)
 * and auto-expires client-side. No DB, no migration.
 */

const PRESENCE_TTL_S = 15;

const presenceKey = (conversationId: string, userId: string): string =>
  `chatbot:presence:${conversationId}:${userId}`;

const presencePattern = (conversationId: string): string =>
  `chatbot:presence:${conversationId}:*`;

const isPresenceViewer = (value: unknown): value is PresenceViewer =>
  typeof value === "object" &&
  value !== null &&
  "userId" in value &&
  typeof value.userId === "string" &&
  "name" in value &&
  typeof value.name === "string";

/** List the viewers currently present on a conversation (TTL-pruned). */
export const listViewers = async (
  conversationId: string,
): Promise<PresenceViewer[]> => {
  const pattern = presencePattern(conversationId);
  const keys: string[] = [];
  let cursor = "0";
  /* oxlint-disable no-await-in-loop -- SCAN cursor must advance sequentially */
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  /* oxlint-enable no-await-in-loop */
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  const viewers: PresenceViewer[] = [];
  for (const value of values) {
    if (!value) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (isPresenceViewer(parsed)) viewers.push(parsed);
    } catch {
      // skip a malformed entry rather than fail the whole roster
    }
  }
  return viewers;
};

/** Mark a viewer present (heartbeat) and broadcast the refreshed roster. */
export const markPresent = async (
  conversationId: string,
  viewer: PresenceViewer,
): Promise<void> => {
  await redis.set(
    presenceKey(conversationId, viewer.userId),
    JSON.stringify(viewer),
    "EX",
    PRESENCE_TTL_S,
  );
  await publishConversationEvent(conversationId, {
    type: "presence",
    viewers: await listViewers(conversationId),
  });
};

/** Drop a viewer (clean tab close) and broadcast the refreshed roster. */
export const removePresent = async (
  conversationId: string,
  userId: string,
): Promise<void> => {
  await redis.del(presenceKey(conversationId, userId));
  await publishConversationEvent(conversationId, {
    type: "presence",
    viewers: await listViewers(conversationId),
  });
};

/** Broadcast a typing on/off signal (transient, no storage). */
export const publishTyping = async (
  conversationId: string,
  viewer: { userId: string; name: string },
  isTyping: boolean,
): Promise<void> => {
  await publishConversationEvent(conversationId, {
    type: "typing",
    userId: viewer.userId,
    name: viewer.name,
    isTyping,
  });
};
