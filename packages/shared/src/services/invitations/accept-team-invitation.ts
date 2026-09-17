import { and, count, eq } from "drizzle-orm";

import db from "../../db";
import { invitation, type member, team, teamMember } from "../../db/schema";
import { MAX_MEMBERS_PER_TEAM } from "../../lib/auth-constants";
import { teamMembershipKey } from "../../lib/team-membership-key";

type InvitationRow = typeof invitation.$inferSelect;
type MemberRow = typeof member.$inferSelect;

export type AcceptTeamInvitationRefusal =
  | "INVITATION_NOT_FOUND"
  | "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"
  | "TEAM_NOT_FOUND"
  | "TEAM_MEMBER_LIMIT_REACHED";

export type AcceptTeamInvitationResult =
  /** The accepting user is not yet in the organization — not ours to handle. */
  | { status: "not-a-member" }
  | { status: "accepted"; invitation: InvitationRow; member: MemberRow }
  | { status: "refused"; reason: AcceptTeamInvitationRefusal };

/**
 * Accept an invitation on behalf of someone who ALREADY belongs to the
 * organization — the other half of `invite-member-to-team.ts`.
 *
 * Better Auth's `/organization/accept-invitation` ends with an unconditional
 * `createMember()`, and the `member` table carries no unique index on
 * `(organization_id, user_id)`: letting an existing member through it writes a
 * SECOND organization membership row for the same person. Every
 * `findFirst`-shaped role lookup in this codebase then reads whichever row
 * Postgres returns first, so the duplicate is not cosmetic — it makes a
 * member's role non-deterministic. This path adds the `team_member` row and
 * leaves the existing `member` row exactly as it was.
 *
 * The seat accounting mirrors what Better Auth's `addTeamMemberWithLimit`
 * maintains: `team.member_count` is the counter its limit is enforced
 * against, so a row inserted here has to move it. `SELECT … FOR UPDATE` on the
 * team row makes the count-then-insert atomic instead of optimistic — two
 * invitees accepting at the same instant cannot both take the last seat.
 */
export const acceptTeamInvitationForMember = async (params: {
  invitationId: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptTeamInvitationResult> => {
  const invited = await db.query.invitation.findFirst({
    where: { id: params.invitationId },
  });
  if (!invited) return { status: "refused", reason: "INVITATION_NOT_FOUND" };

  const existingMember = await db.query.member.findFirst({
    where: { organizationId: invited.organizationId, userId: params.userId },
  });
  if (!existingMember) return { status: "not-a-member" };

  // Same three refusals Better Auth makes, in the same order, so an expired or
  // misaddressed invitation answers identically whichever path served it.
  if (invited.status !== "pending" || invited.expiresAt < new Date()) {
    return { status: "refused", reason: "INVITATION_NOT_FOUND" };
  }
  if (invited.email.toLowerCase() !== params.userEmail.toLowerCase()) {
    return {
      status: "refused",
      reason: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    };
  }

  // An organization-level invitation to someone already inside it grants
  // nothing. Mark it accepted so it stops sitting in the pending list rather
  // than leaving a dead row the invitee can click forever.
  if (!invited.teamId) {
    const accepted = await markAccepted(params.invitationId);
    return accepted
      ? { status: "accepted", invitation: accepted, member: existingMember }
      : { status: "refused", reason: "INVITATION_NOT_FOUND" };
  }

  const teamId = invited.teamId;
  const membershipKey = await teamMembershipKey(teamId, params.userId);

  const outcome = await db.transaction(
    async (
      tx,
    ): Promise<
      | { ok: true; invitation: InvitationRow }
      | { ok: false; reason: AcceptTeamInvitationRefusal }
    > => {
      // Lock the team row first: the seat check and the insert below have to
      // be one decision, and this is the row whose counter they both move.
      const [locked] = await tx
        .select({ id: team.id })
        .from(team)
        .where(
          and(
            eq(team.id, teamId),
            eq(team.organizationId, invited.organizationId),
          ),
        )
        .for("update");
      if (!locked) return { ok: false, reason: "TEAM_NOT_FOUND" };

      const already = await tx
        .select({ id: teamMember.id })
        .from(teamMember)
        .where(
          and(
            eq(teamMember.teamId, teamId),
            eq(teamMember.userId, params.userId),
          ),
        )
        .limit(1);

      if (already.length === 0) {
        const [seats] = await tx
          .select({ used: count() })
          .from(teamMember)
          .where(eq(teamMember.teamId, teamId));
        const used = seats?.used ?? 0;
        if (used >= MAX_MEMBERS_PER_TEAM) {
          return { ok: false, reason: "TEAM_MEMBER_LIMIT_REACHED" };
        }

        await tx.insert(teamMember).values({
          teamId,
          userId: params.userId,
          membershipKey,
          createdAt: new Date(),
        });
        // Set, not increment: we hold the lock and have just counted, so this
        // also repairs a counter that drifted before the lock existed.
        await tx
          .update(team)
          .set({ memberCount: used + 1 })
          .where(eq(team.id, teamId));
      }

      // Guarded on `pending` so two concurrent accepts cannot both report
      // success for the same invitation.
      const [accepted] = await tx
        .update(invitation)
        .set({ status: "accepted" })
        .where(
          and(
            eq(invitation.id, params.invitationId),
            eq(invitation.status, "pending"),
          ),
        )
        .returning();
      if (!accepted) return { ok: false, reason: "INVITATION_NOT_FOUND" };

      return { ok: true, invitation: accepted };
    },
  );

  if (!outcome.ok) return { status: "refused", reason: outcome.reason };
  return {
    status: "accepted",
    invitation: outcome.invitation,
    member: existingMember,
  };
};

const markAccepted = async (
  invitationId: string,
): Promise<InvitationRow | undefined> => {
  const [row] = await db
    .update(invitation)
    .set({ status: "accepted" })
    .where(
      and(eq(invitation.id, invitationId), eq(invitation.status, "pending")),
    )
    .returning();
  return row;
};
