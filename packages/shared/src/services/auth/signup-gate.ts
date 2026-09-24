import { and, eq, gt } from "drizzle-orm";

import { adapterFor } from "../../authz/access";
import db from "../../db";
import {
  invitation,
  signupAllowedDomains,
  signupAllowlist,
} from "../../db/schema";
import { grantsOfInvitation } from "../access/guests/invitation-grants";

/**
 * Closed-beta sign-up gate. Self-serve registration is restricted while the
 * product is in beta: a user may only create an account if their email has a
 * pending organization invitation (`findSignupInvitation`) OR is
 * explicitly authorised — by email (`signup_allowlist`) or by domain
 * (`signup_allowed_domains`). Both are managed by super-admins from the admin
 * pages. Consumed by the `databaseHooks.user.create.before` hook in `auth.ts`.
 */

/**
 * The header the invitation page sends on sign-up: the id of the invitation
 * whose link the person followed. The id is the one secret the invitation
 * email delivers, so presenting it is what proves the person reads that inbox.
 */
export const SIGNUP_INVITATION_HEADER = "x-fretik-invitation-id";

export type SignupInvitation = {
  /**
   * The team whose language the new account starts in: the one the
   * invitation joins first, or — for a guest, who joins none — the team of
   * the first item shared with them.
   */
  teamId: string | null;
  /**
   * Whether the sign-up presented THIS invitation's id. Only then may the
   * account skip email verification: a pending invitation merely EXISTING for
   * an address says nothing about who is typing it, and auto-verifying on that
   * alone let anyone register an invited address before its owner did — and
   * then accept the invitation as them.
   */
  ownershipProven: boolean;
};

/**
 * The pending, unexpired invitation behind a sign-up, if the address has one.
 * An invited address may register during the closed beta even without the
 * link; it then verifies its email like any other sign-up.
 */
export const findSignupInvitation = async (params: {
  email: string;
  /** The id presented with the sign-up (`SIGNUP_INVITATION_HEADER`), if any. */
  invitationId: string | null;
}): Promise<SignupInvitation | null> => {
  const normalized = params.email.trim().toLowerCase();
  if (!normalized) return null;

  const rows = await db
    .select({ id: invitation.id, teamId: invitation.teamId })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, normalized),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  if (rows.length === 0) return null;

  const presented = rows.find((row) => row.id === params.invitationId);
  const chosen = presented ?? rows[0];
  return {
    // Better Auth stores a multi-team invitation as a comma-joined list.
    teamId:
      chosen?.teamId?.split(",")[0] ??
      (chosen ? await teamOfFirstItem(chosen.id) : null),
    ownershipProven: presented !== undefined,
  };
};

/** The team holding the first item an invitation was sent for, if any. */
const teamOfFirstItem = async (
  invitationId: string,
): Promise<string | null> => {
  const [first] = await grantsOfInvitation(db, invitationId);
  if (!first) return null;
  const node = (await adapterFor(first.type).loadNodes([first.id])).get(
    first.id,
  );
  return node?.teamId ?? null;
};

/**
 * True when the email may create an account during the closed beta: it is on
 * the per-email allowlist OR its domain is on the allowed-domains list.
 * Invitation-based access is handled separately by `findSignupInvitation`.
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
