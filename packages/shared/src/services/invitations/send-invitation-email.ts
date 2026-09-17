import { generateOrganizationInvitation } from "../../emails/generators";
import { sendEmail } from "../../lib/email";
import { getTeamLocale } from "../field-definitions/get-locale";

export interface OrganizationInvitationEmailParams {
  invitationId: string;
  /** Recipient address, exactly as stored on the invitation row. */
  email: string;
  inviterName: string;
  organizationName: string;
  role: string;
  teamId: string | null;
  expiresAt: Date;
  /**
   * The invitee is ALREADY a member of the organization and this invitation
   * only grants access to one more team. Selects the "access to a new team"
   * copy instead of the "join the organization" one — same template, one
   * different paragraph and subject line.
   */
  existingMember?: boolean;
}

/**
 * Render and send an organization invitation email.
 *
 * Extracted from the Better Auth `sendInvitationEmail` callback because the
 * team-invitation path (`invite-member-to-team.ts`) writes its own `invitation`
 * row and therefore has to send its own email: two copies of "which locale,
 * which template, which subject" would drift the moment either is touched.
 *
 * Localized to the inviting TEAM's language — the invitee usually has no
 * account yet, so a per-user language isn't available (falls back to `en` for
 * organization-level invitations with no team).
 */
export const sendOrganizationInvitationEmail = async (
  params: OrganizationInvitationEmailParams,
): Promise<void> => {
  const lang = params.teamId ? await getTeamLocale(params.teamId) : "en";

  const { subject, html } = await generateOrganizationInvitation(
    {
      invitationId: params.invitationId,
      inviterName: params.inviterName,
      organizationName: params.organizationName,
      role: params.role,
      teamId: params.teamId,
      expiresAt: params.expiresAt,
      existingMember: params.existingMember ?? false,
    },
    lang,
  );

  await sendEmail({ to: { email: params.email }, subject, html });
};
