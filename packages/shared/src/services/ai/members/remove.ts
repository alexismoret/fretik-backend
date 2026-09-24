import { and, eq } from "drizzle-orm";
import { requireAccess } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { forbidden, notFound, throwHttpError } from "../../../lib/errors";
import type { ConversationMember } from "../conversation-serializer";
import { getConversation } from "../get";

/**
 * Remove a participant from a conversation. Anyone may leave; taking someone
 * else out takes full access to it — its owner, or whoever it gives full
 * access — not only a seat. The `owner` can never be removed, which protects
 * the creator from being locked out of their own thread. Returns the
 * refreshed roster.
 */
export const removeConversationMember = async (data: {
  conversationId: string;
  teamId: string;
  principal: UserPrincipal;
  targetUserId: string;
}): Promise<ConversationMember[]> => {
  const { conversationId, teamId, principal, targetUserId } = data;
  const requesterId = principal.userId;

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
  if (targetUserId !== requesterId) {
    await requireAccess({
      principal,
      type: "conversation",
      id: conversationId,
      required: "full",
      notFoundMessage: "Conversation not found",
    });
  }

  await db
    .delete(aiConversationMembers)
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        eq(aiConversationMembers.userId, targetUserId),
      ),
    );

  // Someone who left no longer reads the chat: the roster they leave behind
  // is the one they just saw, without them.
  if (targetUserId === requesterId) {
    return conversation.members.filter(
      (member) => member.userId !== requesterId,
    );
  }
  const refreshed = await getConversation({
    id: conversationId,
    teamId,
    userId: requesterId,
  });
  return refreshed?.members ?? [];
};
