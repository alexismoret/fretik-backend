import db from "../db";
import { forbidden, throwHttpError } from "./errors";
import { redis, selectOrCache } from "./redis";

/**
 * Cross-handler role gating + member-role cache.
 *
 * Single source of truth for "is this user an admin/owner of the
 * organization that owns this team". Handlers that gate writes on
 * org-admin role (field-definitions, team-skills, …)
 * MUST call `assertOrgAdmin` rather than re-implementing the
 * `member.role` lookup. Re-implementations drift (TTL, cache key,
 * error message) and have to be patched in N places when policy
 * changes.
 */

/**
 * Cache key for the member-role lookup. Nested under
 * `organization:{orgId}:` so a full-org invalidation
 * `deleteKeysByPrefix('organization:{orgId}:')` cleans member-role
 * caches too.
 */
export const memberRoleCacheKey = (
  organizationId: string,
  userId: string,
): string => `organization:${organizationId}:member-role:${userId}`;

/**
 * TTL for the member-role cache (seconds). 15 min is enough — org
 * membership rarely changes and a 15-min delay between role change
 * and reflected access is acceptable.
 */
export const MEMBER_ROLE_CACHE_TTL = 15 * 60;

/**
 * Assert the user is an admin or owner of the given organization.
 * Throws a 403 `FORBIDDEN` HTTPException otherwise — returns `never`
 * for TS narrowing in handlers.
 *
 * Lookup is Redis-cached under `memberRoleCacheKey` so the typical
 * cost is a single Redis GET per request. Cache invalidation happens
 * on the Better Auth side when a member's role changes (organisation
 * write hooks call `deleteKeysByPrefix('organization:{orgId}:')`).
 */
export const assertOrgAdmin = async (data: {
  userId: string;
  organizationId: string;
  /** Optional override for the 403 message. Defaults to a generic line. */
  message?: string;
}): Promise<void> => {
  const member = await selectOrCache(
    () =>
      db.query.member.findFirst({
        columns: { role: true },
        where: {
          userId: data.userId,
          organizationId: data.organizationId,
        },
      }),
    memberRoleCacheKey(data.organizationId, data.userId),
    MEMBER_ROLE_CACHE_TTL,
  );
  const role = member?.role;
  if (role !== "admin" && role !== "owner") {
    return throwHttpError(
      403,
      forbidden(data.message ?? "This action requires admin or owner role"),
    );
  }
};

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
 * TTL for the team-membership cache (seconds). Aligned with the member-role
 * cache — both gate access, and both are invalidated explicitly on removal, so
 * the TTL is only a backstop.
 */
export const TEAM_MEMBERSHIP_CACHE_TTL = MEMBER_ROLE_CACHE_TTL;

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
 * Better Auth's `removeMember` bulk-deletes their `team_member` rows in one
 * statement, so `afterRemoveTeamMember` never fires per row and the org-level
 * hook has to sweep the teams itself.
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
