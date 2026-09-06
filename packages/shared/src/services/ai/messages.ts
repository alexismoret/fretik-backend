import type { UIMessage } from "ai";
import { and, asc, desc, eq, gt, lte, notInArray, sql } from "drizzle-orm";
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
    // Surfaced so a resuming client can trim the active turn's partial
    // messages before replaying the turn log (and flag interrupted turns).
    ...(row.turnId ? { turnId: row.turnId } : {}),
  };
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

/**
 * Drop `partial: true` rows belonging to a turn that also has a FINISHED row.
 * Reading net for the same mid-turn id rename `deleteStalePartialMessages`
 * cleans up on write: the invariant is that a turn only gets non-partial rows
 * once it reached `onFinish`, so any partial row still sitting beside one is a
 * dead prefix of the same turn — rendered as a duplicate assistant message.
 *
 * Rows whose turn has no finished row are left alone: that is a genuinely
 * interrupted turn, and history is supposed to show it (with its "interrupted"
 * badge). Best-effort on a windowed read — a partial whose finished sibling
 * falls outside the `limit` survives, which is the safe direction.
 */
const dropStalePartialRows = (
  rows: (typeof aiMessages.$inferSelect)[],
): (typeof aiMessages.$inferSelect)[] => {
  const isPartial = (row: typeof aiMessages.$inferSelect): boolean =>
    row.metadata?.partial === true;
  const finishedTurns = new Set(
    rows
      .filter((row) => row.turnId !== null && !isPartial(row))
      .map((row) => row.turnId),
  );
  if (finishedTurns.size === 0) return rows;
  return rows.filter(
    (row) => !(isPartial(row) && finishedTurns.has(row.turnId)),
  );
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
 * Load a conversation's messages in chronological order. Used by the
 * frontend to rehydrate a conversation when the user navigates to it.
 *
 * `limit` returns the LAST N messages (still oldest-first) — the mount
 * path passes one so a python-heavy 200-turn conversation doesn't ship
 * multi-MB of parts jsonb on every reload. Omitted → full history.
 *
 * Returns UIMessage[] in the exact shape @ai-sdk/vue's Chat expects.
 */
export const getConversationMessages = async (
  conversationId: string,
  limit?: number,
): Promise<UIMessage[]> => {
  if (limit !== undefined) {
    const rows = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(desc(aiMessages.seq))
      .limit(limit);
    return dropStalePartialRows(rows.reverse()).map(rowToUiMessage);
  }
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.seq));

  return dropStalePartialRows(rows).map(rowToUiMessage);
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
    .orderBy(desc(aiMessages.seq))
    .limit(limit);

  return dropStalePartialRows(rows.reverse()).map(rowToUiMessage);
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
    .orderBy(asc(aiMessages.seq));

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
    .orderBy(desc(aiMessages.seq))
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
 *
 * When `id` is provided (the message's wire id from the AI SDK stream), the
 * row keeps that id and a re-save of the same id converges via upsert —
 * transcript ids are then identical on the wire, in DB, and after reload,
 * which is what lets the frontend rehydrate without remounting anything.
 * The conflict guard is scoped to the same conversation so a colliding id
 * from another conversation can never be overwritten.
 */
export const saveMessage = async (data: {
  conversationId: string;
  role: Role;
  parts: UIMessage["parts"];
  metadata?: unknown;
  /** Human author of a `user` message; null/omitted for assistant/system. */
  authorId?: string | null;
  /** Wire id of the message; omitted → DB generates a uuid v7. */
  id?: string;
  /** Stream id of the turn that produced this message (assistant rows). */
  turnId?: string | null;
}) => {
  const [row] = await db
    .insert(aiMessages)
    .values({
      ...(data.id ? { id: data.id } : {}),
      conversationId: data.conversationId,
      role: data.role,
      parts: data.parts,
      metadata: toRecordMetadata(data.metadata),
      authorId: data.authorId ?? null,
      turnId: data.turnId ?? null,
    })
    .onConflictDoUpdate({
      target: aiMessages.id,
      set: {
        parts: sql`excluded.parts`,
        metadata: sql`excluded.metadata`,
        turnId: sql`excluded.turn_id`,
      },
      setWhere: sql`${aiMessages.conversationId} = excluded.conversation_id`,
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
 *
 * Same id semantics as `saveMessage`: wire ids are preserved and re-saves
 * of the same id converge (idempotent upsert, scoped to the conversation).
 * The incremental turn recorder and the final `onFinish` write both go
 * through here with the same ids, so whichever lands last simply refreshes
 * `parts`/`metadata` in place.
 */
export const saveMessages = async (
  conversationId: string,
  messages: {
    role: Role;
    parts: UIMessage["parts"];
    metadata?: unknown;
    authorId?: string | null;
    id?: string;
    turnId?: string | null;
  }[],
  tx?: Transaction,
) => {
  if (messages.length === 0) return [];

  const rows = await (tx ?? db)
    .insert(aiMessages)
    .values(
      messages.map((m) => ({
        ...(m.id ? { id: m.id } : {}),
        conversationId,
        role: m.role,
        parts: m.parts,
        metadata: toRecordMetadata(m.metadata),
        authorId: m.authorId ?? null,
        turnId: m.turnId ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: aiMessages.id,
      set: {
        parts: sql`excluded.parts`,
        metadata: sql`excluded.metadata`,
        turnId: sql`excluded.turn_id`,
      },
      setWhere: sql`${aiMessages.conversationId} = excluded.conversation_id`,
    })
    .returning();

  await touchConversation(conversationId, tx);

  return rows;
};

/**
 * Delete a turn's leftover `partial: true` rows once its final rows have
 * landed. `keepIds` are the ids the final write persisted; anything else
 * still marked partial under the same `turnId` is a dead prefix.
 *
 * Such a prefix exists whenever the wire message id CHANGES mid-turn. Every
 * merged `toUIMessageStream` emits its own `start` chunk with a fresh id, so
 * a turn that fails over to the fallback model (or continues after a dead
 * step) renames the message the recorder has been writing under. The recorder
 * keys its upserts by wire id, so the pre-rename row is never overwritten by
 * `onFinish` — it survives as a second assistant message holding a PREFIX of
 * the same parts. On reload the thread then shows that prefix immediately
 * followed by the complete message: duplicated steps, and two step-group
 * pills back to back with nothing between them.
 *
 * Gated on `partial` so a finished message can never be deleted, and on
 * `turnId` so only this turn's rows are in scope.
 *
 * `notInArray` rather than a hand-written `<> ALL(…::uuid[])`: the raw form
 * bound the id list as ONE parameter, and the driver sent a bare uuid string
 * where Postgres wanted an array literal. Every chat turn therefore died here
 * with `malformed array literal`, INSIDE the turn's transaction — so the
 * authoritative message write and the `chat.turn` journal entry rolled back
 * with it. What the user saw: a complete answer that reloads as "interrupted"
 * (the recorder's `partial` rows were all that survived) and a conversation
 * that refused the next prompt (the slot release never ran either, before it
 * was moved out of the transaction's blast radius). One malformed cast, two
 * headline symptoms.
 */
export const deleteStalePartialMessages = async (params: {
  conversationId: string;
  turnId: string;
  keepIds: string[];
  tx?: Transaction;
}): Promise<number> => {
  const { conversationId, turnId, keepIds, tx } = params;
  const deleted = await (tx ?? db)
    .delete(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        eq(aiMessages.turnId, turnId),
        sql`${aiMessages.metadata} ->> 'partial' = 'true'`,
        keepIds.length > 0 ? notInArray(aiMessages.id, keepIds) : sql`true`,
      ),
    )
    .returning({ id: aiMessages.id });
  return deleted.length;
};
