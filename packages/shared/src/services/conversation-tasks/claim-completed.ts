import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { type Transaction } from "../../db";
import type { ConversationBackgroundTask } from "../../db/schema";
import {
  CONVERSATION_TASK_TERMINAL_STATUSES,
  conversationBackgroundTasks,
} from "../../db/schema";

/**
 * Take ownership of every settled-but-unconsumed task of a conversation —
 * but only once the conversation owes nothing else.
 *
 * This single statement IS the fan-in rule. Two runs finishing at the same
 * moment both signal a possible resume; each tries to claim; the one that
 * still sees a `pending` sibling (the other run, not yet committed) matches
 * zero rows, and the second one takes the whole batch. Exactly one resume per
 * batch, without a lock or a counter to keep in sync.
 *
 * The caller resumes the conversation with the returned rows and, if it fails
 * before the continuation is persisted, releases them via
 * `releaseClaimedConversationTasks`. Pass `tx` to make the claim atomic with
 * the continuation-message write — a process dying between the two must not
 * leave rows consumed with no message describing them.
 */
export const claimCompletedConversationTasks = async (
  conversationId: string,
  tx?: Transaction,
): Promise<ConversationBackgroundTask[]> => {
  const pending = alias(conversationBackgroundTasks, "pending_sibling");
  return (tx ?? db)
    .update(conversationBackgroundTasks)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        inArray(conversationBackgroundTasks.status, [
          ...CONVERSATION_TASK_TERMINAL_STATUSES,
        ]),
        isNull(conversationBackgroundTasks.consumedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(pending)
            .where(
              and(
                eq(pending.conversationId, conversationId),
                eq(pending.status, "pending"),
              ),
            ),
        ),
      ),
    )
    .returning();
};

/**
 * Hand back rows claimed by a resume that never got to persist its
 * continuation message, so the next signal (turn-end drain or sweep) can
 * retry them. Best-effort: a failure here only delays the retry to the sweep.
 */
export const releaseClaimedConversationTasks = async (
  taskIds: string[],
): Promise<void> => {
  if (taskIds.length === 0) return;
  await db
    .update(conversationBackgroundTasks)
    .set({ consumedAt: null })
    .where(inArray(conversationBackgroundTasks.id, taskIds));
};
