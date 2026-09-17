import { and, count, eq } from "drizzle-orm";

import db from "../../db";
import { invitation, teamMember } from "../../db/schema";
import {
  INVITATION_EXPIRY_SECONDS,
  MAX_MEMBERS_PER_TEAM,
} from "../../lib/auth-constants";
import { findOrganizationMemberByEmail } from "../organization/find-member-by-email";
import { sendOrganizationInvitationEmail } from "./send-invitation-email";

type InvitationRow = typeof invitation.$inferSelect;

/**
 * Why a team invitation could not be created. Each maps 1:1 onto the error
 * the Better Auth endpoint returns for the equivalent situation, so the
 * frontend only ever has to know one vocabulary of codes.
 */
export type TeamInvitationRefusal =
  | "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION"
  | "ORGANIZATION_NOT_FOUND"
  | "TEAM_NOT_FOUND"
  | "USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM"
  | "TEAM_MEMBER_LIMIT_REACHED";

export type InviteMemberToTeamResult =
  /** The address has no account in this organization — not ours to handle. */
  | { status: "not-a-member" }
  | { status: "created"; invitation: InvitationRow }
  | { status: "refused"; reason: TeamInvitationRefusal };

/**
 * Invite someone who is ALREADY an organization member to one more team.
 *
 * Better Auth's `/organization/invite-member` refuses this outright
 * (`USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION`) — its invitation is a
 * door into the organization, and you cannot walk through a door you are
 * already behind. With `teams.enabled`, though, a second team is a real
 * grant: the member gains a workspace they could not see before. This service
 * writes that invitation itself; `lib/auth-hooks.ts` routes the request here
 * before the plugin's guard can refuse it, and
 * `accept-team-invitation.ts` completes the other half.
 *
 * What it deliberately does NOT do: touch the member's organization role. The
 * role on the row is the one they ALREADY hold, recorded so the pending list
 * shows the truth — a team invitation is not a role change, and role changes
 * have their own UI (`updateMemberRole`). Accepting adds a `team_member` row
 * and nothing else.
 *
 * Returns `not-a-member` rather than throwing when the address is unknown or
 * outside the organization: that is the ordinary invitation, and Better Auth
 * handles it.
 */
export const inviteMemberToTeam = async (params: {
  organizationId: string;
  teamId: string;
  email: string;
  /** The caller — must be an owner/admin of the organization. */
  inviterUserId: string;
}): Promise<InviteMemberToTeamResult> => {
  const email = params.email.trim().toLowerCase();

  const invitee = await findOrganizationMemberByEmail({
    organizationId: params.organizationId,
    email,
  });
  if (!invitee) return { status: "not-a-member" };

  // Same gate Better Auth applies through `hasPermission({ invitation:
  // ["create"] })`: with no custom `roles` configured, its default statements
  // grant invitation creation to owner and admin only.
  const inviter = await db.query.member.findFirst({
    columns: { role: true },
    where: {
      organizationId: params.organizationId,
      userId: params.inviterUserId,
    },
  });
  if (inviter?.role !== "owner" && inviter?.role !== "admin") {
    return {
      status: "refused",
      reason: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    };
  }

  const targetTeam = await db.query.team.findFirst({
    columns: { id: true },
    where: { id: params.teamId, organizationId: params.organizationId },
  });
  if (!targetTeam) return { status: "refused", reason: "TEAM_NOT_FOUND" };

  const alreadyInTeam = await db.query.teamMember.findFirst({
    columns: { id: true },
    where: { teamId: params.teamId, userId: invitee.userId },
  });
  if (alreadyInTeam) {
    return {
      status: "refused",
      reason: "USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM",
    };
  }

  // Refuse a seat the accept path would have to refuse anyway — better here,
  // where an admin is watching, than in the invitee's inbox a day later.
  const [seats] = await db
    .select({ used: count() })
    .from(teamMember)
    .where(eq(teamMember.teamId, params.teamId));
  if ((seats?.used ?? 0) >= MAX_MEMBERS_PER_TEAM) {
    return { status: "refused", reason: "TEAM_MEMBER_LIMIT_REACHED" };
  }

  const org = await db.query.organization.findFirst({
    columns: { name: true },
    where: { id: params.organizationId },
  });
  if (!org) return { status: "refused", reason: "ORGANIZATION_NOT_FOUND" };

  const inviterUser = await db.query.user.findFirst({
    columns: { name: true },
    where: { id: params.inviterUserId },
  });

  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_SECONDS * 1000);

  const created = await db.transaction(async (tx) => {
    // Better Auth's `cancelPendingInvitationsOnReInvite` cancels every pending
    // invitation for the address in the organization; scoped to the TEAM here
    // on purpose. Once a member can hold invitations to several teams at once,
    // the org-wide sweep would silently drop a pending invitation to a
    // different team every time someone was invited to another one.
    await tx
      .update(invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(invitation.organizationId, params.organizationId),
          eq(invitation.email, email),
          eq(invitation.teamId, params.teamId),
          eq(invitation.status, "pending"),
        ),
      );

    const [row] = await tx
      .insert(invitation)
      .values({
        organizationId: params.organizationId,
        email,
        // The role they already hold — see the note above.
        role: invitee.role,
        teamId: params.teamId,
        status: "pending",
        expiresAt,
        inviterId: params.inviterUserId,
      })
      .returning();
    return row;
  });

  if (!created) {
    throw new Error(
      `Failed to create team invitation for ${email} on team ${params.teamId}`,
    );
  }

  await sendOrganizationInvitationEmail({
    invitationId: created.id,
    email: created.email,
    inviterName: inviterUser?.name ?? "",
    organizationName: org.name,
    role: created.role ?? "member",
    teamId: created.teamId,
    expiresAt: created.expiresAt,
    existingMember: true,
  });

  return { status: "created", invitation: created };
};
