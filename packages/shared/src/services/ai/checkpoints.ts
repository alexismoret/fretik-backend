/**
 * Persisted conversation checkpoints — the resume point an agent window starts
 * from.
 *
 * Until 2026-09-17 compaction was purely in-memory: the summariser ran, the
 * turn used its result, and the next turn reloaded the same raw history and
 * paid for the same summary again. That is what forced the chatbot's
 * compaction cap to sit at 300 000 tokens rather than at the context ceiling —
 * measured, 22 % of production conversations (166 of 745) carry more than
 * 400 KB of parts, and lowering the threshold without persisting the result
 * would have put a 10-40 s summariser call in front of every message in all of
 * them. Anthropic, OpenAI and Claude Code all persist and re-append their
 * compaction artefact; this module is that missing piece.
 *
 * Everything here is designed around one sentence: **a checkpoint is derived
 * data that must never be able to lose a message.** The three rules that
 * follow from it are enforced by the callers and re-stated in the table's
 * docblock (`db/schema/ai.ts`):
 *
 *  1. the cut comes from the window the turn actually READ, never from
 *     `MAX(seq)` at write time — see `writeCheckpoint`;
 *  2. it never crosses a row that can still change — see `checkpointCut`;
 *  3. the rows under it are never deleted, so any checkpoint can be rebuilt.
 */

import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { aiConversationCheckpoints } from "../../db/schema";

/**
 * Beyond this many stacked summaries, the writer re-summarises from the raw
 * rows under the frontier instead of from the previous summary.
 *
 * A checkpoint is normally built from a window that already STARTS with the
 * previous checkpoint's summary, so each generation is a summary of a summary
 * — a shape this codebase has already measured and rejected once (the team
 * digest, deleted 2026-09-11: "a second model pass over model output is a
 * summary of summaries"). Anthropic and OpenAI have the same property and the
 * same non-answer; what we can do that they document no path for is REPAIR,
 * because `up_to_message_id` is a foreign key and the raw rows are still there.
 *
 * 5 is a bound, not a measurement — it is the point past which nothing of the
 * original wording can reasonably be expected to survive. Lower it if the
 * long-context suite says the fall starts earlier.
 */
export const MAX_CHECKPOINT_GENERATION = 5;

export interface ConversationCheckpoint {
  id: string;
  upToSeq: number;
  upToMessageId: string;
  summary: string;
  activatedTools: string[];
  participantIds: string[];
  generation: number;
  kind: "llm" | "mechanical" | "truncated";
}

/**
 * The newest checkpoint for a conversation, or `null`.
 *
 * One backwards scan of `ai_conversation_checkpoints_conv_seq_idx`. A rewound
 * checkpoint is not filtered out here — it is already gone, cascade-deleted
 * with the message it pointed at.
 */
export const loadLatestCheckpoint = async (
  conversationId: string,
): Promise<ConversationCheckpoint | null> => {
  const [row] = await db
    .select({
      id: aiConversationCheckpoints.id,
      upToSeq: aiConversationCheckpoints.upToSeq,
      upToMessageId: aiConversationCheckpoints.upToMessageId,
      summary: aiConversationCheckpoints.summary,
      activatedTools: aiConversationCheckpoints.activatedTools,
      participantIds: aiConversationCheckpoints.participantIds,
      generation: aiConversationCheckpoints.generation,
      kind: aiConversationCheckpoints.kind,
    })
    .from(aiConversationCheckpoints)
    .where(eq(aiConversationCheckpoints.conversationId, conversationId))
    .orderBy(sql`${aiConversationCheckpoints.upToSeq} DESC`)
    .limit(1);
  return row ?? null;
};

/**
 * Persist a checkpoint. Returns `true` when this call wrote it.
 *
 * Fire-and-forget by design — the turn that crossed the threshold already has
 * its context loaded, so making it wait 15 s for a summary buys it nothing;
 * it runs as it is (bounded by the intra-turn ceiling), the checkpoint lands
 * afterwards, and the NEXT turn starts small. No latency is ever added.
 *
 * Two turns can legitimately run on one conversation at once —
 * `/internal/invoke` never claims the stream slot and the workflow path uses
 * `forceSetConversationActiveStream`. They compute DIFFERENT cuts, so the
 * unique index alone would let both insert and leave the reader free to pick
 * the one built on staler history. The advisory lock serialises them and
 * `ON CONFLICT DO NOTHING` makes the loser a no-op rather than an error.
 *
 * The caller MUST have checked that the turn was not discarded; the foreign
 * key is the second line of defence, not the first — it catches a rewind that
 * lands between the check and the insert (the row vanishes, the insert fails),
 * which is precisely the race a check alone cannot close.
 */
export const writeCheckpoint = async (input: {
  conversationId: string;
  upToMessageId: string;
  upToSeq: number;
  summary: string;
  activatedTools: string[];
  participantIds: string[];
  generation: number;
  kind: "llm" | "mechanical" | "truncated";
  tokensBefore: number;
  tokensAfter: number;
}): Promise<boolean> => {
  return db.transaction(async (tx) => {
    // Scoped to the transaction, so it is released on commit or rollback with
    // nothing to unlock by hand.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.conversationId}))`,
    );
    const inserted = await tx
      .insert(aiConversationCheckpoints)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: aiConversationCheckpoints.id });
    return inserted.length > 0;
  });
};

/**
 * Drop every checkpoint at or after `seq`. Call it INSIDE the transaction that
 * deletes the messages.
 *
 * Redundant with the `ON DELETE CASCADE` on `up_to_message_id` — and kept
 * anyway, because the two cover different anchors. The cascade fires when the
 * pointed-at row is itself deleted; a checkpoint whose anchor sits exactly ON
 * the rewind anchor (which `rewind` keeps and re-saves in place) survives the
 * cascade while summarising the message's OLD wording. `>=`, not `>`, for
 * that reason.
 */
export const deleteCheckpointsFrom = async (
  conversationId: string,
  seq: number,
  tx: Pick<typeof db, "delete">,
): Promise<void> => {
  await tx
    .delete(aiConversationCheckpoints)
    .where(
      and(
        eq(aiConversationCheckpoints.conversationId, conversationId),
        sql`${aiConversationCheckpoints.upToSeq} >= ${seq}`,
      ),
    );
};

/**
 * Does this conversation have any checkpoint at all?
 *
 * Used by the auto-title gate, which asks "is this the conversation's first
 * turn?" and until now answered it with "does the loaded window contain an
 * assistant message?". Those are the same question only while the window is
 * the whole history: anchored on a checkpoint, a 300-turn conversation can
 * present a window with no assistant message in it and get re-titled from
 * whatever was last said.
 */
export const hasCheckpoint = async (
  conversationId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: aiConversationCheckpoints.id })
    .from(aiConversationCheckpoints)
    .where(eq(aiConversationCheckpoints.conversationId, conversationId))
    .limit(1);
  return row !== undefined;
};

/**
 * How many raw rows a repair re-summarises.
 *
 * The repair exists because generation N is a summary of a summary N times
 * over; it does NOT pretend to recover a conversation from its first message.
 * Bounding it is what makes it safe to run in the background: an unbounded
 * "everything under the frontier" would hand the summariser a history of
 * arbitrary size, and the rows it would reach past this bound have already
 * been through `MAX_CHECKPOINT_GENERATION` summaries — there is little left in
 * them to recover.
 */
export const CHECKPOINT_REPAIR_ROW_LIMIT = 200;
