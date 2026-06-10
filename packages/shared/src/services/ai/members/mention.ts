import { and, eq, inArray } from "drizzle-orm";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { listTeamMembers, type TeamMember } from "../../team/members";

/**
 * Apply the @mentions carried by a user message. Each mentioned teammate is:
 *  - added to the conversation if not already a member (idempotent), and
 *  - flagged with `mentionedAt = now` so their conversation list shows an
 *    "action required" badge until they read.
 *
 * The author is never mentioned to themselves, and only real (non-bot) team
 * members are honoured. Returns the mentioned members so the caller (the AI
 * handler) can send the notification emails — keeping email I/O out of the
 * data layer.
 */
export const applyMentions = async (data: {
  conversationId: string;
  teamId: string;
  byUserId: string;
  mentionedUserIds: string[];
}): Promise<TeamMember[]> => {
  const { conversationId, teamId, byUserId, mentionedUserIds } = data;
  if (mentionedUserIds.length === 0) return [];

  const byId = new Map(
    (await listTeamMembers(teamId)).map((m) => [m.userId, m]),
  );
  const mentioned = [...new Set(mentionedUserIds)]
    .filter((id) => id !== byUserId && byId.has(id))
    .map((id) => byId.get(id)!);

  if (mentioned.length === 0) return [];
  const ids = mentioned.map((m) => m.userId);

  await db
    .insert(aiConversationMembers)
    .values(
      ids.map((userId) => ({
        conversationId,
        userId,
        role: "member" as const,
      })),
    )
    .onConflictDoNothing();

  await db
    .update(aiConversationMembers)
    .set({ mentionedAt: new Date() })
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        inArray(aiConversationMembers.userId, ids),
      ),
    );

  return mentioned;
};
