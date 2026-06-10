import db from "../../db";
import { getTeamBotUserId } from "../auth/bot-user";

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

/**
 * Every human member of a team. The per-team bot user (`member.role = 'bot'`)
 * is excluded — it backs the agent and must never appear in a roster, a
 * member picker, or a mention list.
 */
export const listTeamMembers = async (
  teamId: string,
): Promise<TeamMember[]> => {
  const botUserId = await getTeamBotUserId(teamId);

  const rows = await db.query.teamMember.findMany({
    where: { teamId },
    with: {
      user: { columns: { id: true, name: true, email: true, image: true } },
    },
  });

  return rows
    .filter((r) => r.userId !== botUserId && r.user !== null)
    .map((r) => ({
      userId: r.userId,
      name: r.user?.name ?? "",
      email: r.user?.email ?? "",
      image: r.user?.image ?? null,
    }));
};

/**
 * Narrow a set of user ids to those that are real (non-bot) members of the
 * team — deduplicated. Used to validate who may be added to a conversation so
 * a caller can't seat someone from another team or the bot itself.
 */
export const filterTeamMemberIds = async (
  teamId: string,
  userIds: string[],
): Promise<string[]> => {
  if (userIds.length === 0) return [];

  const allowed = new Set((await listTeamMembers(teamId)).map((m) => m.userId));
  return [...new Set(userIds)].filter((id) => allowed.has(id));
};
