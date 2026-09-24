import db from "../../db";
import {
  generateOrganizationInvitation,
  type InvitationItem,
} from "../../emails/generators";
import { sendEmail } from "../../lib/email";
import { normalizeLocale } from "../../lib/locales";
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
  /**
   * The item shared with them by email (`services/access/guests/`), with the
   * team that holds it: the email names the item, and is written in that
   * team's language when the invitation joins no team of its own.
   */
  item?: (InvitationItem & { teamId: string | null }) | null;
}

/**
 * Render and send an organization invitation email.
 *
 * The one place an invitation email is made. Every invitation path
 * (`invite-to-team.ts`, a guest invited from the share dialog) writes its own
 * `invitation` row through Better Auth's adapter, below the endpoint that
 * would have sent it (closed, `lib/auth-replaced-endpoints.ts`), and so sends
 * its own email: two copies of "which locale, which template, which subject"
 * would drift the moment either is touched.
 *
 * Someone who already has a Fretik account, in another organization, reads
 * it in their own language and is told to sign in with that account: the
 * invitation page opens on signing in, never on a sign-up. The inviter learns
 * nothing of it; only the email, which goes to that address alone, differs.
 *
 * Anyone else reads it in the inviting TEAM's language. A guest joins no
 * team: theirs is the language of the team whose item they were invited onto
 * (falls back to `en` for organization-level invitations with neither).
 */
export const sendOrganizationInvitationEmail = async (
  params: OrganizationInvitationEmailParams,
): Promise<void> => {
  const account = await db.query.user.findFirst({
    columns: { language: true },
    where: { email: params.email.trim().toLowerCase() },
  });
  const localeTeamId = params.teamId ?? params.item?.teamId ?? null;
  const lang = account
    ? normalizeLocale(account.language)
    : localeTeamId
      ? await getTeamLocale(localeTeamId)
      : "en";

  const { subject, html } = await generateOrganizationInvitation(
    {
      invitationId: params.invitationId,
      inviterName: params.inviterName,
      organizationName: params.organizationName,
      role: params.role,
      teamId: params.teamId,
      expiresAt: params.expiresAt,
      existingMember: params.existingMember ?? false,
      existingAccount: account !== undefined,
      item: params.item ?? null,
    },
    lang,
  );

  await sendEmail({ to: { email: params.email }, subject, html });
};
