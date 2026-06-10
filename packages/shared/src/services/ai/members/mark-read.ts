import { and, eq } from "drizzle-orm";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";

/**
 * Mark a conversation as read for one user: stamp `lastReadAt` now and clear
 * any pending `mentionedAt`. This clears both the unread dot and the
 * action-required badge. Scoped to the caller's own membership row, so it's a
 * no-op for non-members.
 */
export const markConversationRead = async (data: {
  conversationId: string;
  userId: string;
}): Promise<void> => {
  const { conversationId, userId } = data;

  await db
    .update(aiConversationMembers)
    .set({ lastReadAt: new Date(), mentionedAt: null })
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        eq(aiConversationMembers.userId, userId),
      ),
    );
};
