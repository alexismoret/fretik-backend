import { eq, sql } from "drizzle-orm";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { team, teamMember, teamSettings } from "../../db/schema";
import type { TeamSummary } from "../../schemas/teams";

/**
 * The organization's teams, with how many people each holds and the
 * principal's own role in it.
 *
 * Every member may read this list (`directory.read` at the route; guests are
 * refused there): knowing a team exists opens nothing in it — its content
 * takes its own rules. The team's agent user is not counted.
 */
export const listOrganizationTeams = async (
  principal: UserPrincipal,
): Promise<TeamSummary[]> => {
  const rows = await db
    .select({
      id: team.id,
      name: team.name,
      createdAt: team.createdAt,
      memberCount:
        sql<number>`count(${teamMember.userId}) filter (where ${teamMember.userId} is distinct from ${teamSettings.botUserId})`.mapWith(
          Number,
        ),
    })
    .from(team)
    .leftJoin(teamSettings, eq(teamSettings.teamId, team.id))
    .leftJoin(teamMember, eq(teamMember.teamId, team.id))
    .where(eq(team.organizationId, principal.organizationId))
    .groupBy(team.id, teamSettings.botUserId)
    .orderBy(team.name);

  return rows.map((row) => ({
    ...row,
    role: principal.teamRoles.get(row.id) ?? null,
  }));
};
