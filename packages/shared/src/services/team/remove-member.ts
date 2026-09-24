import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import { onMemberLeftTeam } from "../../lib/auth-membership";
import { notFound, throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import type { TeamMemberEntry } from "../../schemas/teams";
import { recordAccessEvent } from "../access/record-event";
import { findOrganizationTeam, findTeamSeat } from "./find";
import { listTeamRoster } from "./roster";

/**
 * Take one person out of a team — and only the team: they stay in the
 * organization, in their other teams, and keep what is shared with them
 * directly. Anyone may leave a team on their own; removing someone else is
 * the team's leads' call, and the organization's admins'
 * (`team.members.manage`).
 *
 * What leaving a team sets in motion — their private workflows of that team
 * pausing, their cached access dropped — is `onMemberLeftTeam`'s, the same
 * steps Better Auth's own removal runs.
 */
export const removeTeamMember = async (input: {
  principal: UserPrincipal;
  teamId: string;
  userId: string;
}): Promise<TeamMemberEntry[]> => {
  const { principal } = input;
  const found = await findOrganizationTeam(principal, input.teamId);
  if (input.userId !== principal.userId) {
    await requireCapability({
      principal,
      capability: "team.members.manage",
      teamId: found.id,
    });
  }
  const seat = await findTeamSeat(found.id, input.userId);
  if (!seat) {
    return throwHttpError(404, notFound("This person is not in the team"));
  }

  const adapter = await organizationAdapter();
  // The role row goes with the membership (`ON DELETE CASCADE`).
  await adapter.removeTeamMember({ teamId: found.id, userId: seat.userId });
  await recordAccessEvent({
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    action: "team_member.removed",
    principal: { type: "user", id: seat.userId },
    metadata: {
      teamId: found.id,
      teamName: found.name,
      userName: seat.name,
      role: seat.role,
      left: seat.userId === principal.userId,
    },
  });
  await onMemberLeftTeam({
    organizationId: principal.organizationId,
    teamId: found.id,
    userId: seat.userId,
  });
  return listTeamRoster(found.id);
};
