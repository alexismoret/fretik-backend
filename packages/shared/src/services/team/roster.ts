import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import {
  teamMember,
  teamMemberRoles,
  teamSettings,
  user,
} from "../../db/schema";
import type { TeamRole } from "../../schemas/access";
import type { TeamMemberEntry } from "../../schemas/teams";

const ROLE_ORDER: Record<TeamRole, number> = { lead: 0, member: 1, viewer: 2 };

/**
 * A team's people with their role, leads first, then by name. The team's
 * agent user is left out: it backs the assistant and never appears in a
 * roster.
 */
export const listTeamRoster = async (
  teamId: string,
): Promise<TeamMemberEntry[]> => {
  const rows = await db
    .select({
      userId: teamMember.userId,
      name: user.name,
      email: user.email,
      image: user.image,
      role: teamMemberRoles.role,
      joinedAt: teamMember.createdAt,
    })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .leftJoin(teamMemberRoles, eq(teamMemberRoles.teamMemberId, teamMember.id))
    .leftJoin(teamSettings, eq(teamSettings.teamId, teamMember.teamId))
    .where(
      and(
        eq(teamMember.teamId, teamId),
        sql`${teamMember.userId} is distinct from ${teamSettings.botUserId}`,
      ),
    );

  return rows
    .map((row) => ({ ...row, role: row.role ?? ("member" as const) }))
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name),
    );
};
