import db from "../../db";

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
}

export const getPublicInvitationPreview = async (
  invitationId: string,
): Promise<PublicInvitationPreview> => {
  const invitation = await db.query.invitation.findFirst({
    where: { id: invitationId },
    columns: {
      email: true,
      role: true,
      status: true,
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
  };
};
