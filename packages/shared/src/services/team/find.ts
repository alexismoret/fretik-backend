import { and, eq, sql } from "drizzle-orm";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import {
  teamMember,
  teamMemberRoles,
  teamSettings,
  user,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { TeamRole } from "../../schemas/access";

/**
 * A team of the principal's organization, or 404 — a team of another
 * organization answers exactly like one that does not exist.
 */
export const findOrganizationTeam = async (
  principal: UserPrincipal,
  teamId: string,
): Promise<{ id: string; name: string; createdAt: Date }> => {
  const row = await db.query.team.findFirst({
    columns: { id: true, name: true, createdAt: true },
    where: { id: teamId, organizationId: principal.organizationId },
  });
  if (!row) return throwHttpError(404, notFound("Team not found"));
  return row;
};

/** One person's seat in a team: the membership row and their role there. */
export interface TeamSeat {
  readonly teamMemberId: string;
  readonly userId: string;
  readonly name: string;
  readonly role: TeamRole;
}

/**
 * A person's seat in a team, or null. The team's agent user has none as far
 * as anyone managing the team is concerned: it cannot be given a role, nor
 * removed, nor counted.
 */
export const findTeamSeat = async (
  teamId: string,
  userId: string,
): Promise<TeamSeat | null> => {
  const [row] = await db
    .select({
      teamMemberId: teamMember.id,
      userId: teamMember.userId,
      name: user.name,
      role: teamMemberRoles.role,
    })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .leftJoin(teamMemberRoles, eq(teamMemberRoles.teamMemberId, teamMember.id))
    .leftJoin(teamSettings, eq(teamSettings.teamId, teamMember.teamId))
    .where(
      and(
        eq(teamMember.teamId, teamId),
        eq(teamMember.userId, userId),
        sql`${teamMember.userId} is distinct from ${teamSettings.botUserId}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  // No role row is a member: every team_member predating roles is one.
  return { ...row, role: row.role ?? "member" };
};
