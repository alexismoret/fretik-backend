import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { notFound, throwHttpError } from "../../../lib/errors";
import { filterTeamMemberIds } from "../../team/members";
import type { ConversationMember } from "../conversation-serializer";
import { getConversation } from "../get";

/**
 * Add team members to a conversation (flat model — any participant may add
 * others). Target ids are narrowed to real, non-bot members of the team, then
 * inserted idempotently. Returns the refreshed roster.
 */
export const addConversationMembers = async (data: {
  conversationId: string;
  teamId: string;
  requesterId: string;
  userIds: string[];
}): Promise<ConversationMember[]> => {
  const { conversationId, teamId, requesterId, userIds } = data;

  const conversation = await getConversation({
    id: conversationId,
    teamId,
    userId: requesterId,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  const validIds = await filterTeamMemberIds(teamId, userIds);
  if (validIds.length > 0) {
    await db
      .insert(aiConversationMembers)
      .values(
        validIds.map((userId) => ({
          conversationId,
          userId,
          role: "member" as const,
        })),
      )
      .onConflictDoNothing();
  }

  const refreshed = await getConversation({
    id: conversationId,
    teamId,
    userId: requesterId,
  });
  return refreshed!.members;
};
