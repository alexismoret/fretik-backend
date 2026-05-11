import type { UIMessage } from "ai";
import { asc, desc, eq } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";

type Role = "user" | "assistant" | "system";

const rowToUiMessage = (row: typeof aiMessages.$inferSelect): UIMessage => ({
  id: row.id,
  role: row.role,
  parts: row.parts,
  ...(row.metadata ? { metadata: row.metadata } : {}),
});

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
}) => {
  const [row] = await db
    .insert(aiMessages)
    .values({
      conversationId: data.conversationId,
      role: data.role,
      parts: data.parts,
      metadata: toRecordMetadata(data.metadata),
    })
    .returning();

  return row;
};

/**
 * Batch insert. More efficient when the agent produces several assistant
 * messages in one turn (tool calls + final text across multiple steps).
 */
export const saveMessages = async (
  conversationId: string,
  messages: { role: Role; parts: UIMessage["parts"]; metadata?: unknown }[],
) => {
  if (messages.length === 0) return [];

  return db
    .insert(aiMessages)
    .values(
      messages.map((m) => ({
        conversationId,
        role: m.role,
        parts: m.parts,
        metadata: toRecordMetadata(m.metadata),
      })),
    )
    .returning();
};
