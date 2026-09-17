/**
 * Better Auth 1.7's `team_member.membership_key`:
 * base64url(sha256(JSON.stringify([teamId, userId]))), unpadded.
 *
 * Recomputed here for the two rows this codebase inserts WITHOUT going through
 * Better Auth's `addTeamMember` — the per-team bot user
 * (`services/auth/bot-user.ts`) and the team invitation an existing
 * organization member accepts (`services/invitations/accept-team-invitation.ts`).
 * A NULL key would still work (Better Auth's lookup falls back to the
 * `(teamId, userId)` pair) but would leave the single-column uniqueness
 * boundary unenforced for exactly the rows we control.
 *
 * Lives in `lib/` rather than next to either writer so there is ONE
 * implementation: two copies of a hash definition drift silently, and the
 * column they feed is `UNIQUE`.
 */
export const teamMembershipKey = async (
  teamId: string,
  userId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, userId])),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
