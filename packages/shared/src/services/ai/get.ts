import db from "../../db";
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
