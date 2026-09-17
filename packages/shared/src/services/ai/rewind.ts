import { and, eq, gt } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";
import { markTurnDiscarded } from "./discarded-turns";

/**
 * How many times one user message may be re-sent with new wording.
 *
 * A cap and not a free-for-all because every edit throws away the answers that
 * followed it: without one, a conversation can be rewritten indefinitely and
 * the transcript stops being a record of anything. Three is what the big
 * assistants settle on, and it is enforced HERE rather than in the UI — the
 * frontend's disabled pencil is a courtesy, this is the rule.
 *
 * A RETRY does not spend it. Re-running the same question changes nothing
 * about what was asked, so the transcript still says what it always said; the
 * cap exists to stop the question from being rewritten, not to ration answers.
 */
export const MAX_USER_MESSAGE_EDITS = 3;

/** Why a rewind was refused. The caller maps these onto HTTP statuses. */
export type RewindRefusal =
  "not-found" | "not-a-user-message" | "not-the-author" | "limit-reached";

export type RewindResult =
  | {
      ok: true;
      /**
       * The edit count the caller must stamp on the re-saved message — read
       * from the locked row, not from the request. Unchanged after a retry,
       * and stamped all the same: the re-save carries client-supplied
       * metadata, so a client that sent back `editCount: 0` would otherwise
       * win itself three fresh edits on every retry.
       */
      nextEditCount: number;
      /** Turn ids whose output the rewind just deleted (now unwanted). */
      discardedTurnIds: string[];
      /** How many rows the rewind removed — for the log line. */
      deletedMessages: number;
    }
  | { ok: false; reason: RewindRefusal; editCount: number };

const editCountOf = (metadata: Record<string, unknown> | null): number => {
  const raw = metadata?.editCount;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : 0;
};

/**
 * Rewind a conversation to one of its user messages: everything that came
 * AFTER it is deleted, so the turn about to run answers the edited prompt with
 * no trace of what the old wording produced. The message row itself is left
 * untouched — the caller re-saves it through the normal `saveMessage` upsert,
 * which keeps its id, its `seq` and its `created_at` (the bubble stays where it
 * was in the thread, carrying its original timestamp) while replacing `parts`.
 *
 * Deletion, not a soft flag: the agent rebuilds each turn from
 * `loadConversationForAgent`, so a hidden-but-present row would still be read
 * back to the model — the user would see one conversation and the assistant
 * another.
 *
 * Only the message's own author may rewind it. A conversation can have several
 * participants, and one of them discarding a colleague's exchange is not an
 * edit, it is a deletion of someone else's work.
 *
 * Runs in a transaction with the anchor row locked: two tabs racing the same
 * edit must not both pass the limit check.
 *
 * Two callers, one rewind. An EDIT re-sends the message with new wording and
 * spends one of its three; a RETRY re-sends it verbatim and spends nothing, so
 * it is neither counted nor refused once the budget is gone. Both delete
 * everything after the anchor — that part is the same operation, which is why
 * it is one function and not two.
 */
export const rewindConversationToUserMessage = async (params: {
  conversationId: string;
  messageId: string;
  /** Caller — must be the message's author. */
  userId: string;
  /**
   * `true` for an edit (new wording): checks the budget and spends one.
   * `false` for a retry (same wording): neither checks nor spends.
   */
  countsAsEdit: boolean;
}): Promise<RewindResult> => {
  const { conversationId, messageId, userId, countsAsEdit } = params;

  const outcome = await db.transaction(async (tx): Promise<RewindResult> => {
    const [anchor] = await tx
      .select({
        role: aiMessages.role,
        authorId: aiMessages.authorId,
        metadata: aiMessages.metadata,
        seq: aiMessages.seq,
      })
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.id, messageId),
          eq(aiMessages.conversationId, conversationId),
        ),
      )
      .for("update");
    if (!anchor) {
      return { ok: false, reason: "not-found", editCount: 0 };
    }
    const editCount = editCountOf(anchor.metadata);
    if (anchor.role !== "user") {
      return { ok: false, reason: "not-a-user-message", editCount };
    }
    if (anchor.authorId !== userId) {
      return { ok: false, reason: "not-the-author", editCount };
    }
    if (countsAsEdit && editCount >= MAX_USER_MESSAGE_EDITS) {
      return { ok: false, reason: "limit-reached", editCount };
    }

    const deleted = await tx
      .delete(aiMessages)
      .where(
        and(
          eq(aiMessages.conversationId, conversationId),
          gt(aiMessages.seq, anchor.seq),
        ),
      )
      .returning({ turnId: aiMessages.turnId });

    const discardedTurnIds = [
      ...new Set(
        deleted
          .map((row) => row.turnId)
          .filter((turnId): turnId is string => turnId !== null),
      ),
    ];

    return {
      ok: true,
      nextEditCount: countsAsEdit ? editCount + 1 : editCount,
      discardedTurnIds,
      deletedMessages: deleted.length,
    };
  });

  // Outside the transaction: a Redis write has nothing to roll back, and a
  // marker set for a rewind that then aborts would silence a turn nobody
  // cancelled. Sequential — a rewind touches one or two turns, never a batch.
  if (outcome.ok) {
    for (const turnId of outcome.discardedTurnIds) {
      // oxlint-disable-next-line no-await-in-loop
      await markTurnDiscarded(turnId);
    }
  }

  return outcome;
};
