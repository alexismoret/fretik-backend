import type { UIMessage } from "ai";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { aiConversations, aiMessages } from "../../db/schema";

type Role = "user" | "assistant" | "system";

/**
 * Project a stored row into a UIMessage. The human author of a `user` message
 * is surfaced under `metadata.authorId` (not a UIMessage field of its own) so
 * it flows unchanged to both the frontend (per-message avatar) and the agent
 * (conditional `[Name]:` speaker labels) without widening the SDK type.
 */
const rowToUiMessage = (row: typeof aiMessages.$inferSelect): UIMessage => {
  const metadata = {
    ...(row.metadata ?? {}),
    ...(row.authorId ? { authorId: row.authorId } : {}),
  };
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

/**
 * Bump a conversation's `updatedAt` so it counts as the last-activity marker
 * that drives list ordering and per-member unread detection. Inserting a
 * message doesn't touch the parent row on its own.
 */
const touchConversation = async (
  conversationId: string,
  tx?: Transaction,
): Promise<void> => {
  await (tx ?? db)
    .update(aiConversations)
    .set({ updatedAt: new Date() })
    .where(eq(aiConversations.id, conversationId));
};

/**
 * Load every message of a conversation in chronological order. Used by the
 * frontend to rehydrate a conversation when the user navigates to it.
 *
 * Returns UIMessage[] in the exact shape @ai-sdk/vue's Chat expects.
 */
export const getConversationMessages = async (
  conversationId: string,
): Promise<UIMessage[]> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt));

  return rows.map(rowToUiMessage);
};

/**
 * Load the last N messages for feeding into the agent's memory window.
 * Returned in chronological order (oldest first) so they can be passed
 * directly to `streamText({ messages })`.
 *
 * Default raised to 30 in Phase 8: the `services/compaction` pipeline
 * needs a large enough tail to trigger its 12K-token threshold on real
 * long conversations. The model never sees all 30 verbatim — anything
 * older than the last 8 gets collapsed into a single system summary by
 * `compactConversation`.
 */
export const loadConversationForAgent = async (
  conversationId: string,
  limit = 30,
): Promise<UIMessage[]> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);

  return rows.reverse().map(rowToUiMessage);
};

/**
 * Load every message created strictly after `since`, in chronological order.
 * Backs the "summarise what I missed" catch-up: `since` is the requesting
 * member's `lastReadAt` (or `joinedAt`).
 */
export const loadMessagesSince = async (
  conversationId: string,
  since: Date,
): Promise<UIMessage[]> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        gt(aiMessages.createdAt, since),
      ),
    )
    .orderBy(asc(aiMessages.createdAt));

  return rows.map(rowToUiMessage);
};

/**
 * Load up to `limit` messages created at or before `before`, in chronological
 * order. Backs the catch-up's grounding window — the last few already-read
 * messages give the summariser enough context to make sense of the unread
 * tail without re-reading the whole thread.
 */
export const loadMessagesBefore = async (
  conversationId: string,
  before: Date,
  limit: number,
): Promise<UIMessage[]> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        lte(aiMessages.createdAt, before),
      ),
    )
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);

  return rows.reverse().map(rowToUiMessage);
};

/**
 * Coerce any metadata blob we receive from the AI SDK (`UIMessage.metadata`,
 * typed as `JSONValue`) into the `Record<string, unknown>` shape the
 * aiMessages table column expects. Non-object values are dropped — we
 * don't want to persist bare strings or numbers as top-level metadata.
 */
const toRecordMetadata = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

/**
 * Persist a single message. Used during a stream's lifecycle: the incoming
 * user message is saved before streaming starts, then each assistant
 * message produced by the agent is saved in the `onFinish` callback (with
 * all its parts including tool invocations).
 */
export const saveMessage = async (data: {
  conversationId: string;
  role: Role;
  parts: UIMessage["parts"];
  metadata?: unknown;
  /** Human author of a `user` message; null/omitted for assistant/system. */
  authorId?: string | null;
}) => {
  const [row] = await db
    .insert(aiMessages)
    .values({
      conversationId: data.conversationId,
      role: data.role,
      parts: data.parts,
      metadata: toRecordMetadata(data.metadata),
      authorId: data.authorId ?? null,
    })
    .returning();

  await touchConversation(data.conversationId);

  return row;
};

/**
 * Batch insert. More efficient when the agent produces several assistant
 * messages in one turn (tool calls + final text across multiple steps).
 * Pass `tx` to enlist in a caller's transaction — the chatbot handler uses
 * this to commit the turn's messages and its `chat.turn` journal entry
 * atomically (the outbox guarantee).
 */
export const saveMessages = async (
  conversationId: string,
  messages: {
    role: Role;
    parts: UIMessage["parts"];
    metadata?: unknown;
    authorId?: string | null;
  }[],
  tx?: Transaction,
) => {
  if (messages.length === 0) return [];

  const rows = await (tx ?? db)
    .insert(aiMessages)
    .values(
      messages.map((m) => ({
        conversationId,
        role: m.role,
        parts: m.parts,
        metadata: toRecordMetadata(m.metadata),
        authorId: m.authorId ?? null,
      })),
    )
    .returning();

  await touchConversation(conversationId, tx);

  return rows;
};
