import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { teamMemberRoles } from "../../db/schema";
import { onMembershipChanged } from "../../lib/auth-membership";
import { notFound, throwHttpError } from "../../lib/errors";
import type { TeamRole } from "../../schemas/access";
import type { TeamMemberEntry } from "../../schemas/teams";
import { recordAccessEvent } from "../access/record-event";
import { findOrganizationTeam, findTeamSeat } from "./find";
import { listTeamRoster } from "./roster";

/**
 * Give one person a role in a team: lead, member or viewer. The team's leads
 * decide, and the organization's admins, who lead every team
 * (`team.members.manage`).
 *
 * A team may end up with no lead — its admins still run it — so demoting the
 * last one is allowed; the settings page says what it means before asking.
 * The change reaches every open session on its next request: the
 * organization's access version is bumped once it has committed.
 */
export const setTeamMemberRole = async (input: {
  principal: UserPrincipal;
  teamId: string;
  userId: string;
  role: TeamRole;
}): Promise<TeamMemberEntry[]> => {
  const { principal } = input;
  const found = await findOrganizationTeam(principal, input.teamId);
  await requireCapability({
    principal,
    capability: "team.members.manage",
    teamId: found.id,
  });
  const seat = await findTeamSeat(found.id, input.userId);
  if (!seat) {
    return throwHttpError(404, notFound("This person is not in the team"));
  }
  if (seat.role === input.role) return listTeamRoster(found.id);

  await db.transaction(async (tx) => {
    await tx
      .insert(teamMemberRoles)
      .values({
        teamMemberId: seat.teamMemberId,
        teamId: found.id,
        userId: seat.userId,
        role: input.role,
        updatedByUserId: principal.userId,
      })
      .onConflictDoUpdate({
        target: teamMemberRoles.teamMemberId,
        set: { role: input.role, updatedByUserId: principal.userId },
      });
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "team_role.changed",
      principal: { type: "user", id: seat.userId },
      metadata: {
        teamId: found.id,
        teamName: found.name,
        userName: seat.name,
        from: seat.role,
        to: input.role,
      },
    });
  });
  await onMembershipChanged(principal.organizationId);
  return listTeamRoster(found.id);
};
