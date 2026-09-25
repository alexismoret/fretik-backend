import db from "../db";
import { redis } from "./redis";

/**
 * The team-membership cache `authMiddleware` reads on every request.
 *
 * Who may do what is the access engine's (`authz/`): its principal cache is
 * versioned per organization and dropped by every membership change
 * (`bumpAccessVersion`). This one only answers "is the session's active team
 * still theirs", and is dropped explicitly on removal.
 */

/** Cache key for the team row `authMiddleware` reads for the active team. */
export const teamRowCacheKey = (teamId: string): string => `team:${teamId}`;

/**
 * Cache key for the team-membership lookup `authMiddleware` runs on every
 * request. Nested under `team:{teamId}:` like the other team-scoped caches, so
 * a team-wide `deleteKeysByPrefix('team:{teamId}')` clears it too.
 */
export const teamMembershipCacheKey = (
  teamId: string,
  userId: string,
): string => `team:${teamId}:member:${userId}`;

/**
 * TTL for the team-membership cache (seconds). It is invalidated explicitly
 * on removal, so the TTL is only a backstop.
 */
export const TEAM_MEMBERSHIP_CACHE_TTL = 15 * 60;

/**
 * Drop one user's cached membership in one team. Call AFTER the removal
 * commits — a stale entry would keep the team context alive for a caller who
 * no longer belongs to it.
 */
export const invalidateTeamMembershipCache = async (
  teamId: string,
  userId: string,
): Promise<void> => {
  await redis.del(teamMembershipCacheKey(teamId, userId));
};

/**
 * Drop every cached team membership a user holds in an organization.
 * Removing a member (Better Auth's `deleteMember`) bulk-deletes their
 * `team_member` rows in one statement, so leaving the organization sweeps
 * every team's cache itself (`onMemberLeftOrganization`).
 */
export const invalidateOrgTeamMembershipCache = async (
  organizationId: string,
  userId: string,
): Promise<void> => {
  const teams = await db.query.team.findMany({
    columns: { id: true },
    where: { organizationId },
  });
  await Promise.all(
    teams.map((t) => invalidateTeamMembershipCache(t.id, userId)),
  );
};
