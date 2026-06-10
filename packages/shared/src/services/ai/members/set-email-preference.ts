import { and, eq } from "drizzle-orm";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { notFound, throwHttpError } from "../../../lib/errors";
import { getConversation } from "../get";

/**
 * Set the current user's *personal* end-of-turn email opt-in for one
 * conversation. Email-on-completion is per-member: toggling it affects only
 * the caller, never the other participants.
 */
export const setMemberEmailPreference = async (data: {
  conversationId: string;
  teamId: string;
  userId: string;
  emailOnCompletion: boolean;
}): Promise<{ emailOnCompletion: boolean }> => {
  const { conversationId, teamId, userId, emailOnCompletion } = data;

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
    .set({ emailOnCompletion })
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        eq(aiConversationMembers.userId, userId),
      ),
    );

  return { emailOnCompletion };
};
