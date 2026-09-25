import type { UIMessage } from "ai";
import { and, asc, desc, eq, gt, lte, notInArray, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import {
  aiConversationMembers,
  aiConversations,
  aiMessages,
} from "../../db/schema";
import {
  type ConversationCheckpoint,
  loadLatestCheckpoint,
} from "./checkpoints";

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
    // When the message was sent, for the timestamp under a user bubble. LAST
    // in the spread on purpose: the client stamps its own clock so a
    // just-sent message has a time before it has a row, and that guess must
    // lose to the column the instant history is read back. The column also
    // survives an edit (the rewind re-saves the row in place), so the
    // timestamp keeps saying when the message was first sent.
    createdAt: row.createdAt.toISOString(),
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
 * Can this row still change after the turn that read it?
 *
 * Three classes, and a checkpoint that summarises any of them loses the
 * change for good:
 *  - `partial` rows, rewritten in place by `upsertPartialMessage`;
 *  - rows carrying an unresolved approval, mutated in place when the user
 *    answers — matched by output SHAPE, never by tool name, the same way
 *    `detectPendingApproval` reads them back;
 *  - the current turn's own output, which is not in the window at all (that
 *    is what makes the window's max seq the right cut and `MAX(seq)` the
 *    wrong one).
 */
export const isMutableRow = (row: {
  metadata: Record<string, unknown> | null;
  parts: UIMessage["parts"];
}): boolean => {
  if (row.metadata?.partial === true) return true;
  for (const part of row.parts) {
    if (!("output" in part)) continue;
    const output: unknown = part.output;
    if (typeof output !== "object" || output === null) continue;
    if (!("status" in output)) continue;
    if (output.status === "approval_pending") return true;
  }
  return false;
};

/** Where a checkpoint anchors: the last row it summarised. */
export interface CutAnchor {
  seq: number;
  messageId: string;
}

type CutCandidateRow = {
  id: string;
  seq: number;
  metadata: Record<string, unknown> | null;
  parts: UIMessage["parts"];
};

/**
 * Where a checkpoint may cut for EVERY prefix of a window, aligned 1:1 with the
 * rows: `anchors[i]` is the cut a checkpoint takes when `rows[0..i]` is what it
 * summarised, and `null` when nothing at or before `i` is safe to summarise.
 *
 * One array rather than one answer because a checkpoint no longer always cuts
 * at the end of the window: keeping a verbatim tail means summarising a prefix
 * and cutting where that prefix stops, and the caller that decides the tail
 * counts MESSAGES, not seqs. Precomputing the mapping here is what lets it
 * translate one into the other without the rows.
 *
 * Stopping rather than skipping is the point. A checkpoint is a PREFIX of the
 * conversation, so one mutable row freezes every later answer at that row —
 * summarising past it and leaving a hole would put the settled rows after it
 * into neither the summary nor the next window.
 */
export const settledAnchors = (
  rows: CutCandidateRow[],
): (CutAnchor | null)[] => {
  const anchors: (CutAnchor | null)[] = [];
  let anchor: CutAnchor | null = null;
  let frozen = false;
  for (const row of rows) {
    if (!frozen && isMutableRow(row)) frozen = true;
    if (!frozen) anchor = { seq: row.seq, messageId: row.id };
    anchors.push(anchor);
  }
  return anchors;
};

/**
 * The last row of a window that is safe to summarise — the cut of a checkpoint
 * that keeps no verbatim tail. The last entry of `settledAnchors`, by
 * definition, and derived from it so the two can never disagree.
 */
export const settledCut = (rows: CutCandidateRow[]): CutAnchor | null =>
  settledAnchors(rows).at(-1) ?? null;

/**
 * The agent's window: the rows a turn reads, plus where a checkpoint written
 * after that turn is allowed to cut.
 */
export interface AgentWindow {
  /**
   * Rows only — the checkpoint's own summary and activation-replay messages
   * are prepended by the caller, which is the layer that knows what a model
   * should see. See `@fretik/ai` `services/compaction/checkpoint-window.ts`.
   */
  messages: UIMessage[];
  /**
   * The ONLY cut a checkpoint may be written at: the last row of THIS window
   * that is safe to summarise. Null when the window is empty or entirely
   * mutable.
   *
   * Deriving it here rather than at write time is the whole correctness
   * argument. A writer that asked the database for `MAX(seq)` after the turn
   * would summarise up to a row the turn never saw, and the answer the model
   * had just given — persisted by `onFinish` at a higher seq — would fall
   * neither inside the summary nor inside the next window. Perfect amnesia
   * about its own last reply, on every checkpoint.
   */
  cut: CutAnchor | null;
  /**
   * The same answer for every prefix of `messages`, aligned 1:1 with it — what
   * a checkpoint that keeps a verbatim tail cuts at. `cut` is its last entry.
   *
   * See `settledAnchors`.
   */
  anchors: (CutAnchor | null)[];
  /** The checkpoint this window is anchored on, if any. */
  checkpoint: ConversationCheckpoint | null;
}

/**
 * The latest checkpoint, unless the conversation's cast has changed since it
 * was written.
 *
 * A summary is built from transcript text that ALREADY carries `[Name]:`
 * speaker prefixes, so once a member leaves, the summary keeps quoting
 * somebody the conversation no longer contains — and keeps showing their
 * words to whoever remains. Retroactive re-labelling, which the speaker
 * context supports on raw rows, is impossible below a frozen summary.
 *
 * The membership read only happens when the checkpoint froze a cast of two or
 * more, because that is exactly when `buildSpeakerContext` prefixes anything
 * (`participants.length < 2` returns the history untouched). A solo
 * conversation therefore pays nothing for this.
 *
 * Rejecting a checkpoint costs a bigger history read, never correctness — the
 * rows under it were never deleted.
 */
/**
 * Who is in a conversation, as the cast a checkpoint freezes.
 *
 * Exported because the WRITER needs the same list the reader compares against:
 * a checkpoint written with an empty cast is one `usableCheckpoint` will never
 * invalidate, since the guard below only runs at two participants or more. The
 * `/invoke` route has no `conversation.members` of its own to pass, and
 * inventing `[]` there would silently opt those conversations out of the very
 * check this file exists to perform.
 */
export const loadParticipantIds = async (
  conversationId: string,
): Promise<string[]> => {
  const members = await db
    .select({ userId: aiConversationMembers.userId })
    .from(aiConversationMembers)
    .where(eq(aiConversationMembers.conversationId, conversationId));
  return members.map((m) => m.userId);
};

const usableCheckpoint = async (
  conversationId: string,
): Promise<ConversationCheckpoint | null> => {
  const checkpoint = await loadLatestCheckpoint(conversationId);
  if (!checkpoint || checkpoint.participantIds.length < 2) return checkpoint;

  const current = (await loadParticipantIds(conversationId)).sort();
  const frozen = [...checkpoint.participantIds].sort();
  const unchanged =
    current.length === frozen.length &&
    current.every((id, i) => id === frozen[i]);
  if (unchanged) return checkpoint;

  console.info(
    `[checkpoint] discarded reason=participants_changed conversation=${conversationId} frozen=${frozen.length.toString()} current=${current.length.toString()}`,
  );
  return null;
};

/**
 * Load the agent's window: everything after the latest checkpoint, capped at
 * the last N rows.
 *
 * No default, deliberately: the caller owns the figure (`@fretik/ai`
 * `AGENT_WINDOW_ROW_LIMIT`). The old default of 30 assumed compaction would
 * collapse what fell outside; it never could — compaction sees only the rows
 * loaded here, so a row past the limit is neither sent nor summarised.
 *
 * With a checkpoint the window is bounded twice, by `seq > cut` AND by the
 * limit, and the two answer different questions: the checkpoint bounds what is
 * SUMMARISED, the limit bounds what a single turn is willing to carry when a
 * conversation has run away between two checkpoints.
 */
export const loadConversationForAgent = async (
  conversationId: string,
  limit: number,
): Promise<AgentWindow> => {
  const checkpoint = await usableCheckpoint(conversationId);

  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      checkpoint
        ? and(
            eq(aiMessages.conversationId, conversationId),
            gt(aiMessages.seq, checkpoint.upToSeq),
          )
        : eq(aiMessages.conversationId, conversationId),
    )
    .orderBy(desc(aiMessages.seq))
    .limit(limit);

  const kept = dropStalePartialRows(rows.reverse());
  const anchors = settledAnchors(kept);

  return {
    messages: kept.map(rowToUiMessage),
    cut: anchors.at(-1) ?? null,
    anchors,
    checkpoint,
  };
};

/**
 * The last `limit` RAW rows at or before `upToSeq` — no checkpoint anchoring,
 * chronological.
 *
 * The repair path's input. A checkpoint's foreign key guarantees these rows
 * are still there, whatever generation of summary sits above them, which is
 * what makes every checkpoint reconstructible rather than a one-way
 * compression.
 */
export const loadRawMessagesBelow = async (
  conversationId: string,
  upToSeq: number,
  limit: number,
): Promise<UIMessage[]> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        lte(aiMessages.seq, upToSeq),
      ),
    )
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
 *
 * The id of a `user` message comes from the client, so the conflict guard is
 * what stops an upsert from being an overwrite of SOMEONE ELSE's row. A re-save
 * converges only onto a row of the same conversation, the same role and the
 * same author: another participant's message, or an assistant reply, sent back
 * under its id matches nothing and is dropped (the row comes back `undefined`).
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
      setWhere: sql`${aiMessages.conversationId} = excluded.conversation_id
        AND ${aiMessages.role} = excluded.role
        AND ${aiMessages.authorId} IS NOT DISTINCT FROM excluded.author_id`,
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
