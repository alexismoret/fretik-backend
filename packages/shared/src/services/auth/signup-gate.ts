import { and, eq } from "drizzle-orm";

import db from "../../db";
import {
  invitation,
  signupAllowedDomains,
  signupAllowlist,
} from "../../db/schema";

/**
 * Closed-beta sign-up gate. Self-serve registration is restricted while the
 * product is in beta: a user may only create an account if their email has a
 * pending organization invitation (handled by `hasPendingInvitation`) OR is
 * explicitly authorised — by email (`signup_allowlist`) or by domain
 * (`signup_allowed_domains`). Both are managed by super-admins from the admin
 * pages. Consumed by the `databaseHooks.user.create.before` hook in `auth.ts`.
 */

/**
 * True when a pending invitation exists for this email. Used both to gate
 * sign-up and to auto-verify invited users (they proved email ownership by
 * clicking the emailed link).
 */
export const hasPendingInvitation = async (email: string): Promise<boolean> => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const rows = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(eq(invitation.email, normalized), eq(invitation.status, "pending")),
    )
    .limit(1);

  return rows.length > 0;
};

/**
 * The team id of this email's pending invitation, if any. Used by the
 * `user.create.before` hook so an invited user inherits their team's UI
 * language at account creation. Returns null when there is no pending
 * invitation or it is an org-level invitation with no team.
 */
export const getPendingInvitationTeamId = async (
  email: string,
): Promise<string | null> => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const rows = await db
    .select({ teamId: invitation.teamId })
    .from(invitation)
    .where(
      and(eq(invitation.email, normalized), eq(invitation.status, "pending")),
    )
    .limit(1);

  return rows[0]?.teamId ?? null;
};

/**
 * True when the email may create an account during the closed beta: it is on
 * the per-email allowlist OR its domain is on the allowed-domains list.
 * Invitation-based access is handled separately by `hasPendingInvitation`.
 */
export const isEmailAllowlisted = async (email: string): Promise<boolean> => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const emailRows = await db
    .select({ email: signupAllowlist.email })
    .from(signupAllowlist)
    .where(eq(signupAllowlist.email, normalized))
    .limit(1);
  if (emailRows.length > 0) return true;

  const domain = normalized.split("@")[1];
  if (!domain) return false;

  const domainRows = await db
    .select({ domain: signupAllowedDomains.domain })
    .from(signupAllowedDomains)
    .where(eq(signupAllowedDomains.domain, domain))
    .limit(1);

  return domainRows.length > 0;
};
