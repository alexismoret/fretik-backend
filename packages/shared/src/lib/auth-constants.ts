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
 * plugin's `invitationExpiresIn` AND the team-invitation path in
 * `services/invitations/invite-member-to-team.ts`, which writes the
 * `invitation` row itself — the two must not drift.
 */
export const INVITATION_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

/**
 * Seat limit per team. Feeds the organization plugin's
 * `teams.maximumMembersPerTeam` AND the team-invitation accept path, which
 * inserts the `team_member` row itself and therefore has to enforce the same
 * ceiling. The bot user created by `bootstrapTeamWithBotUser` counts against
 * it, exactly as it does on Better Auth's own path.
 */
export const MAX_MEMBERS_PER_TEAM = 50;
