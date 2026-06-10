import { and, eq } from "drizzle-orm";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../../lib/errors";
import type { ConversationMember } from "../conversation-serializer";
import { getConversation } from "../get";

/**
 * Remove a participant from a conversation. Any member may remove another, but
 * the `owner` can never be removed — that protects the creator from being
 * locked out of their own thread. Returns the refreshed roster.
 */
export const removeConversationMember = async (data: {
  conversationId: string;
  teamId: string;
  requesterId: string;
  targetUserId: string;
}): Promise<ConversationMember[]> => {
  const { conversationId, teamId, requesterId, targetUserId } = data;

  const conversation = await getConversation({
    id: conversationId,
    teamId,
    userId: requesterId,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  const target = conversation.members.find((m) => m.userId === targetUserId);
  if (!target) return conversation.members;
  if (target.role === "owner") {
    return throwHttpError(
      403,
      forbidden("The conversation owner cannot be removed"),
    );
  }

  await db
    .delete(aiConversationMembers)
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        eq(aiConversationMembers.userId, targetUserId),
      ),
    );

  const refreshed = await getConversation({
    id: conversationId,
    teamId,
    userId: requesterId,
  });
  return refreshed!.members;
};
