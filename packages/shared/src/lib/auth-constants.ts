/**
 * Shared auth constants. Single source of truth for values that must agree
 * across the Better Auth plugin config (`lib/auth.ts`) and the transactional
 * email copy (`emails/generators.ts`). Change them here only.
 */

/** Lifetime of email one-time-passwords (verification / reset / change). */
export const OTP_EXPIRY_SECONDS = 600;
export const OTP_EXPIRY_MINUTES = OTP_EXPIRY_SECONDS / 60;

/**
 * Lifetime of an organization / team invitation. Feeds the organization
 * plugin's `invitationExpiresIn` AND every invitation written outside its
 * endpoint (`services/invitations/invite-to-team.ts`, the team hook in
 * `auth-hooks.ts`), through `ORG_ADAPTER_OPTIONS` below — they must not drift.
 */
export const INVITATION_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

/**
 * How many invitations an organization may have pending at once. Feeds the
 * plugin's `invitationLimit` (its own default, made explicit) AND
 * `services/invitations/invite-to-team.ts`, so both doors stop at one number.
 */
export const PENDING_INVITATION_LIMIT = 100;

/**
 * How many people an organization holds at most. Feeds the organization
 * plugin's `membershipLimit` through `services/organization/membership-limit.ts`,
 * which leaves out the members who take no seat: the teams' agents and the
 * guests.
 */
export const MAX_PEOPLE_PER_ORGANIZATION = 100;

/**
 * Seat limit per team. Feeds the organization plugin's
 * `teams.maximumMembersPerTeam` AND every path that seats someone through the
 * adapter (the team invitation accept hook, `services/team/*`), which must
 * enforce the same ceiling. The bot user created by `bootstrapTeamWithBotUser`
 * counts against it, exactly as it does on Better Auth's own path.
 */
export const MAX_MEMBERS_PER_TEAM = 50;

/**
 * The organization plugin options its ADAPTER reads, for writes made outside
 * its endpoints (`auth-hooks.ts`, `org-adapter.ts`). `invitationExpiresIn` is
 * the only one that changes a write (`createInvitation` stamps `expiresAt`
 * from it), so it comes from the same constant that configures the plugin.
 */
export const ORG_ADAPTER_OPTIONS: {
  // Annotated rather than inferred: the adapter's return type branches on
  // `O["teams"] extends { enabled: true }`, and a bare object literal widens
  // `enabled` to `boolean` — which silently drops `teamId` off every
  // invitation it hands back.
  teams: { enabled: true };
  invitationExpiresIn: number;
} = {
  teams: { enabled: true },
  invitationExpiresIn: INVITATION_EXPIRY_SECONDS,
};
