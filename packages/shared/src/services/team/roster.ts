import { and, eq, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db from "../../db";
import {
  member,
  team,
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
 * roster, and so is any other agent account.
 *
 * Each person carries their organization role too: an owner or an admin
 * manages every team whatever their role in it, and the page says so next
 * to the role that still decides what they get on the team's content.
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
      organizationRole: member.role,
      joinedAt: teamMember.createdAt,
    })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .innerJoin(user, eq(user.id, teamMember.userId))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, team.organizationId),
        eq(member.userId, teamMember.userId),
      ),
    )
    .leftJoin(teamMemberRoles, eq(teamMemberRoles.teamMemberId, teamMember.id))
    .leftJoin(teamSettings, eq(teamSettings.teamId, teamMember.teamId))
    .where(
      and(
        eq(teamMember.teamId, teamId),
        sql`${teamMember.userId} is distinct from ${teamSettings.botUserId}`,
      ),
    );

  const entries: TeamMemberEntry[] = [];
  for (const row of rows) {
    const organizationRole = parseOrganizationRole(row.organizationRole);
    if (organizationRole === "bot") continue;
    entries.push({
      ...row,
      // No role row is a member: every seat predating roles is one.
      role: row.role ?? "member",
      organizationRole,
    });
  }
  return entries.sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name),
  );
};
