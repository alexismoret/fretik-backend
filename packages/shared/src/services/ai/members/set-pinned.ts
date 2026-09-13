import { and, eq, sql } from "drizzle-orm";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { notFound, throwHttpError } from "../../../lib/errors";
import { getConversation } from "../get";

/**
 * Pin or unpin one conversation for the current user.
 *
 * Per member, like `emailOnCompletion`: a conversation is shared, so a pin
 * stored on the conversation itself would reorder every participant's list.
 *
 * `COALESCE(pinned_at, now())` rather than `now()`: re-pinning something
 * already pinned must be a no-op, or a double click (or a second tab) would
 * move the row to the top of the pinned group under the user's cursor.
 */
export const setMemberPinned = async (data: {
  conversationId: string;
  teamId: string;
  userId: string;
  pinned: boolean;
}): Promise<void> => {
  const { conversationId, teamId, userId, pinned } = data;

  const conversation = await getConversation({
    id: conversationId,
    teamId,
    userId,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  await db
    .update(aiConversationMembers)
    .set({
      pinnedAt: pinned
        ? sql`COALESCE(${aiConversationMembers.pinnedAt}, now())`
        : null,
    })
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        eq(aiConversationMembers.userId, userId),
      ),
    );
};
