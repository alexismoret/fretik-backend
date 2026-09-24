import { z } from "zod";
import type { ResolvedResource } from "../../authz/access";
import type { UserPrincipal } from "../../authz/principal";
import { throwNotVisible } from "../../authz/refusals";
import db from "../../db";
import type { AccessLevel } from "../../schemas/access";
import { assertConversationAccess } from "./assert-conversation-access";
import {
  conversationWith,
  serializeConversation,
  type SerializedConversation,
} from "./conversation-serializer";

/**
 * Fetch a single conversation the user participates in. Access is gated on
 * membership (`members: { userId }`) rather than ownership, so any
 * participant — not just the creator — can read it. Returns `undefined` when
 * the conversation doesn't exist or the user isn't a member.
 */
export const getConversation = async (data: {
  id: string;
  teamId: string;
  userId: string;
}): Promise<SerializedConversation | undefined> => {
  const { id, teamId, userId } = data;

  const row = await db.query.aiConversations.findFirst({
    where: { id, teamId, members: { userId } },
    with: conversationWith,
  });

  return row ? serializeConversation(row, userId) : undefined;
};

/**
 * A conversation as whoever may read it sees it — a participant, or someone
 * it was given to read — once the access engine has decided they may
 * (`access.resource`). Loaded by id wherever its team, with their level; their
 * own state (unread, pin) is empty without a seat.
 */
export const getReadableConversation = async (data: {
  resource: ResolvedResource;
  userId: string;
}): Promise<SerializedConversation | undefined> => {
  const { node, level } = data.resource;
  const row = await db.query.aiConversations.findFirst({
    where: { id: node.id, organizationId: node.organizationId },
    with: conversationWith,
  });
  return row ? serializeConversation(row, data.userId, level) : undefined;
};

/**
 * The conversation a request names in its body, for someone who needs `level`
 * on it — refused as `access.resource` refuses one named in a path: 404 when
 * they cannot see it, 403 with the reason when their level is short. Returns
 * the engine's decision beside it, whose facts say who else reads it
 * (`chatAudience`).
 *
 * The row is read while the decision is made: a turn starts here, and the
 * time to its first token is the sum of what it waits on in series.
 */
export const requireConversation = async (data: {
  principal: UserPrincipal;
  conversationId: string;
  level: AccessLevel;
}): Promise<{
  resource: ResolvedResource;
  conversation: SerializedConversation;
}> => {
  const { principal, conversationId } = data;
  // The row is read before the engine has looked at the id: a malformed one
  // answers like one that does not exist, not with the database's error.
  if (!z.uuid().safeParse(conversationId).success) {
    return throwNotVisible("Conversation not found");
  }
  const [resource, row] = await Promise.all([
    assertConversationAccess({
      conversationId,
      principal,
      level: data.level,
    }),
    db.query.aiConversations.findFirst({
      where: { id: conversationId, organizationId: principal.organizationId },
      with: conversationWith,
    }),
  ]);
  // Deleted between the decision and the read.
  if (!row) return throwNotVisible("Conversation not found");
  return {
    resource,
    conversation: serializeConversation(row, principal.userId, resource.level),
  };
};
