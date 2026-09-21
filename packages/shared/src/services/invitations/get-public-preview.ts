import { and, eq, sql } from "drizzle-orm";

import db from "../../db";
import { member, user } from "../../db/schema";

/**
 * Public-safe projection of an organization invitation, shown on the
 * unauthenticated `/invitation` landing page so an invitee can see who
 * invited them (org, team, person) before deciding to sign up or sign in.
 * Invitation IDs are opaque uuid v7, so exposing this minimal metadata to
 * whoever holds the exact link (the recipient) is safe.
 */
export interface PublicInvitationPreview {
  found: boolean;
  /** "pending" | "accepted" | "rejected" | "canceled" — frontend gates on this + expiresAt. */
  status?: string;
  email?: string;
  role?: string;
  organizationName?: string;
  organizationLogo?: string | null;
  inviterName?: string;
  inviterImage?: string | null;
  teamName?: string | null;
  expiresAt?: Date;
  /**
   * An account already exists for the invited address. Lets the page open on
   * "sign in" instead of walking the invitee into a sign-up that can only
   * fail. NOT an enumeration oracle: it answers for the one address the
   * invitation was mailed to, to whoever holds that mailed link.
   */
  hasAccount?: boolean;
  /**
   * That account is already a member of the inviting organization, so this
   * invitation grants one more TEAM rather than entry to the organization.
   * The page says so instead of welcoming them somewhere they already are.
   */
  alreadyMember?: boolean;
}

/**
 * The account behind an address, and whether it already belongs to the
 * inviting organization.
 *
 * Read here rather than through the organization plugin's adapter because this
 * runs on a PUBLIC Hono route, outside any Better Auth endpoint — there is no
 * `AuthContext` to hand `getOrgAdapter`. The comparison is case-insensitive:
 * `user.email` is stored as the account entered it.
 */
const accountStateForEmail = async (
  email: string,
  organizationId: string,
): Promise<{ hasAccount: boolean; alreadyMember: boolean }> => {
  const normalized = email.trim().toLowerCase();

  const rows = await db
    .select({ userId: user.id, memberId: member.id })
    .from(user)
    .leftJoin(
      member,
      and(
        eq(member.userId, user.id),
        eq(member.organizationId, organizationId),
      ),
    )
    .where(eq(sql`lower(${user.email})`, normalized))
    .limit(1);

  const row = rows[0];
  return {
    hasAccount: row !== undefined,
    alreadyMember: row?.memberId != null,
  };
};

export const getPublicInvitationPreview = async (
  invitationId: string,
): Promise<PublicInvitationPreview> => {
  const invitation = await db.query.invitation.findFirst({
    where: { id: invitationId },
    columns: {
      email: true,
      role: true,
      status: true,
      organizationId: true,
      teamId: true,
      expiresAt: true,
    },
    with: {
      organization: { columns: { name: true, logo: true } },
      inviter: { columns: { name: true, image: true } },
    },
  });

  if (!invitation) return { found: false };

  // Drizzle types `r.one` relations as nullable; the org/inviter FKs are
  // NOT NULL so these always resolve, but guard defensively (no `!` allowed).
  const { organization, inviter } = invitation;
  if (!organization || !inviter) return { found: false };

  // `invitation.teamId` has no FK/relation, so resolve the team name with a
  // separate read (mirrors the invitation email generator).
  let teamName: string | null = null;
  if (invitation.teamId) {
    const team = await db.query.team.findFirst({
      where: { id: invitation.teamId },
      columns: { name: true },
    });
    teamName = team?.name ?? null;
  }

  const account = await accountStateForEmail(
    invitation.email,
    invitation.organizationId,
  );

  return {
    found: true,
    status: invitation.status,
    email: invitation.email,
    role: invitation.role ?? "member",
    organizationName: organization.name,
    organizationLogo: organization.logo,
    inviterName: inviter.name,
    inviterImage: inviter.image,
    teamName,
    expiresAt: invitation.expiresAt,
    hasAccount: account.hasAccount,
    alreadyMember: account.alreadyMember,
  };
};
