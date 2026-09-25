import { requireAccess } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { forbidden, notFound, throwHttpError } from "../../../lib/errors";
import { recordAccessEvent } from "../../access/record-event";
import { deleteGrants } from "../../access/sharing/grant-store";
import type { ConversationMember } from "../conversation-serializer";
import { getConversation } from "../get";

/**
 * Remove a participant from a conversation. Anyone may leave; taking someone
 * else out takes full access to it — its owner, or whoever it gives full
 * access — not only a seat. The `owner` can never be removed, which protects
 * the creator from being locked out of their own thread. The seat goes
 * through the share dialog's store and journal, like any access taken away.
 * Returns the refreshed roster.
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

  const resource = { type: "conversation" as const, id: conversationId };
  const person = { type: "user" as const, id: targetUserId };
  await db.transaction(async (tx) => {
    await deleteGrants(tx, resource, [person]);
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: requesterId,
      action: "grant.removed",
      resource,
      principal: person,
      metadata: {
        previousLevel: "use",
        principalName: target.name,
        resourceName: conversation.title,
      },
    });
  });

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
