import { requireCapability } from "../../authz/gates";
import { parseOrganizationRole } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import {
  MAX_MEMBERS_PER_TEAM,
  PENDING_INVITATION_LIMIT,
} from "../../lib/auth-constants";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import type { AssignableOrganizationRole } from "../../schemas/access";
import { ERROR_CODES } from "../../schemas/errors";
import type { InvitationOutcome } from "../../schemas/members";
import { recordAccessEvent } from "../access/record-event";
import { findOrganizationTeam } from "../team/find";
import { sendOrganizationInvitationEmail } from "./send-invitation-email";

/**
 * Invite people into a team by email: someone new to the organization joins
 * it by accepting, someone already in it gains one more team. Nobody is added
 * without saying yes — that is what an invitation is, and why a team's leads
 * who only want to seat a colleague use "Add people" instead.
 *
 * Who may invite into a team is the organization's policy
 * (`members.invite`: its admins, or the team's leads too). Making someone an
 * ADMIN of the organization stays the admins' own call (`members.manage`),
 * whoever sends the invitation.
 *
 * Every address is resolved before anything is sent, so a refusal — a full
 * team, too many pending invitations, an address that cannot join a team —
 * leaves nothing half-done. Then one address at a time: an email that cannot
 * be sent withdraws its own invitation (`failed`) and the others carry on.
 *
 * The writes go through Better Auth's adapter, which stamps the expiry and
 * encodes the team the same way its own endpoint does; the accept step is
 * Better Auth's (or `auth-hooks.ts`' for someone already in the
 * organization) and is untouched.
 */
export const inviteToTeam = async (input: {
  principal: UserPrincipal;
  teamId: string;
  invitations: readonly { email: string; role: AssignableOrganizationRole }[];
}): Promise<InvitationOutcome[]> => {
  const { principal } = input;
  const { organizationId } = principal;
  const found = await findOrganizationTeam(principal, input.teamId);
  await requireCapability({
    principal,
    capability: "members.invite",
    teamId: found.id,
  });
  if (input.invitations.some((row) => row.role === "admin")) {
    await requireCapability({
      principal,
      capability: "members.manage",
      message: "Only an admin can invite someone as an admin.",
    });
  }

  // One invitation per address, whatever case it was typed in.
  const rows = [
    ...new Map(
      input.invitations.map((row) => {
        const email = row.email.trim().toLowerCase();
        return [email, { email, role: row.role }] as const;
      }),
    ).values(),
  ];

  const adapter = await organizationAdapter();
  const [inviter, organization, team, pending] = await Promise.all([
    db.query.user.findFirst({ where: { id: principal.userId } }),
    db.query.organization.findFirst({
      columns: { name: true },
      where: { id: organizationId },
    }),
    adapter.findTeamById({
      teamId: found.id,
      organizationId,
      includeTeamMembers: true,
    }),
    adapter.findPendingInvitations({ organizationId }),
  ]);
  if (!inviter || !organization || !team) {
    return throwHttpError(404, notFound("Team not found"));
  }
  // An invitation takes no seat until it is accepted, so this is the one
  // question every address would get the same answer to. The accept path
  // asks again, when the seat is actually taken.
  if (team.members.length >= MAX_MEMBERS_PER_TEAM) {
    return throwHttpError(409, {
      code: ERROR_CODES.TEAM_MEMBER_LIMIT_REACHED,
      message: "The team has no seat left.",
    });
  }

  const inTeam = new Set(team.members.map((seat) => seat.userId));
  const resolved = await Promise.all(
    rows.map(async (row) => {
      const existing = await adapter.findMemberByEmail({
        email: row.email,
        organizationId,
      });
      return { ...row, existing };
    }),
  );
  for (const row of resolved) {
    if (row.existing === null) continue;
    const role = parseOrganizationRole(row.existing.role);
    // A team agent is nobody to invite, and a guest sees what is shared
    // with them: neither joins a team through an invitation.
    if (role === "bot" || role === "guest") {
      return throwHttpError(
        400,
        badRequest(`${row.email} can't be invited to a team.`),
      );
    }
  }

  const pendingTo = (email: string) =>
    pending.filter(
      (invitation) =>
        invitation.email.toLowerCase() === email &&
        invitation.teamId === found.id,
    );
  const added = resolved.filter(
    (row) =>
      !(row.existing && inTeam.has(row.existing.userId)) &&
      pendingTo(row.email).length === 0,
  ).length;
  if (pending.length + added > PENDING_INVITATION_LIMIT) {
    return throwHttpError(409, {
      code: ERROR_CODES.INVITATION_LIMIT_REACHED,
      message: `The organization can't have more than ${PENDING_INVITATION_LIMIT.toString()} pending invitations.`,
    });
  }

  const outcomes: InvitationOutcome[] = [];
  for (const row of resolved) {
    if (row.existing && inTeam.has(row.existing.userId)) {
      outcomes.push({
        email: row.email,
        status: "already_in_team",
        invitationId: null,
      });
      continue;
    }

    // Someone already in the organization keeps the role they hold: joining
    // one more team changes nothing else, and the accept path would not
    // keep a promise of anything more.
    const role = row.existing ? row.existing.role : row.role;
    // eslint-disable-next-line no-await-in-loop -- one address at a time
    const invitation = await adapter.createInvitation({
      invitation: {
        email: row.email,
        role,
        organizationId,
        teamIds: [found.id],
      },
      user: inviter,
    });
    try {
      // eslint-disable-next-line no-await-in-loop -- one address at a time
      await sendOrganizationInvitationEmail({
        invitationId: invitation.id,
        email: invitation.email,
        inviterName: inviter.name,
        organizationName: organization.name,
        role: invitation.role,
        teamId: found.id,
        expiresAt: invitation.expiresAt,
        existingMember: row.existing !== null,
      });
    } catch (err) {
      console.warn(`[invitations] email to ${row.email} failed:`, err);
      // eslint-disable-next-line no-await-in-loop -- one address at a time
      await adapter.updateInvitation({
        invitationId: invitation.id,
        status: "canceled",
        fromStatus: "pending",
      });
      outcomes.push({ email: row.email, status: "failed", invitationId: null });
      continue;
    }

    // Only once the new one is on its way: a failed send must not have
    // withdrawn the link they already had. Pending invitations to OTHER teams
    // stay — a person may be invited to several.
    // eslint-disable-next-line no-await-in-loop -- one address at a time
    await Promise.all(
      pendingTo(row.email).map((stale) =>
        adapter.updateInvitation({
          invitationId: stale.id,
          status: "canceled",
          fromStatus: "pending",
        }),
      ),
    );
    // eslint-disable-next-line no-await-in-loop -- one address at a time
    await recordAccessEvent({
      organizationId,
      actorUserId: principal.userId,
      action: "invitation.sent",
      principal: { type: "invitation", id: invitation.id },
      metadata: {
        email: row.email,
        role,
        teamId: found.id,
        teamName: found.name,
        existingMember: row.existing !== null,
      },
    });
    outcomes.push({
      email: row.email,
      status: "invited",
      invitationId: invitation.id,
    });
  }
  return outcomes;
};
