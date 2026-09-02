import { and, eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { ConversationTaskKind } from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * Put a settled task back in the waiting state, because its work started
 * again.
 *
 * Deliberately NOT what `registerConversationTask` does: that one is
 * idempotent and ignores a re-registration precisely so a retried launch
 * cannot resurrect a wait the conversation has already accounted for. This is
 * the opposite intent, and it exists for one case — a failed bulk operation
 * resumed from its ledger. Without it the resumed drain settles a task that is
 * already terminal, `completeConversationTask` reports no transition, and the
 * conversation is never woken: the load finishes and nobody is told.
 *
 * `consumedAt` is cleared with the status. A consumed row is one whose outcome
 * a turn has already read; that outcome is now stale, and leaving the stamp
 * would make the row unclaimable when the new one lands.
 *
 * Only a `failed` row is reopened. A still-`pending` task is already waiting
 * and must keep its place; a `succeeded` or `canceled` one describes work that
 * is over, and reopening it would make the conversation wait for something
 * nobody is doing.
 */
export const reopenConversationTask = async (params: {
  tx?: Transaction;
  kind: ConversationTaskKind;
  ref: string;
}): Promise<void> => {
  await (params.tx ?? db)
    .update(conversationBackgroundTasks)
    .set({ status: "pending", completedAt: null, consumedAt: null })
    .where(
      and(
        eq(conversationBackgroundTasks.kind, params.kind),
        eq(conversationBackgroundTasks.ref, params.ref),
        eq(conversationBackgroundTasks.status, "failed"),
      ),
    );
};
