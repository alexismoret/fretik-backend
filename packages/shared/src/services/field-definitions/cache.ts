import { deleteKeysByPrefix } from "../../lib/redis";

/**
 * Centralised cache-key builders + invalidation for `fieldDefinitions`.
 *
 * Key layout — every key nests under the same scope prefix already used
 * by `auth-middleware.ts` for the org / team row caches
 * (`organization:{id}` and `team:{id}`). The trailing `:field-definitions:`
 * segment means a `deleteKeysByPrefix('team:{teamId}:field-definitions:')`
 * wipes every field-definition variant for that team WITHOUT dropping the
 * team row itself from cache.
 *
 *   • `organization:{orgId}:field-definitions:{objectTypeKey}:{enabled|all}`
 *   • `team:{teamId}:field-definitions:{objectTypeKey}:{enabled|all}`
 *
 * `objectTypeKey` is the object-type key or id the read was scoped to.
 *
 * Writes (create, update, delete, reorder, apply-template, batch-apply,
 * duplicate-org-to-team) call `invalidateFieldDefinitionsCache` AFTER the
 * DB transaction commits — never inside.
 */

export const fieldDefinitionsCacheKeyOrg = (
  organizationId: string,
  objectTypeKey: string,
  includeDisabled: boolean,
): string =>
  `organization:${organizationId}:field-definitions:${objectTypeKey}:${includeDisabled ? "all" : "enabled"}`;

export const fieldDefinitionsCacheKeyTeam = (
  teamId: string,
  objectTypeKey: string,
  includeDisabled: boolean,
): string =>
  `team:${teamId}:field-definitions:${objectTypeKey}:${includeDisabled ? "all" : "enabled"}`;

const orgFieldDefsPrefix = (organizationId: string): string =>
  `organization:${organizationId}:field-definitions:`;

const teamFieldDefsPrefix = (teamId: string): string =>
  `team:${teamId}:field-definitions:`;

/**
 * Invalidate every cached read for a given scope. `teamId === null` →
 * org scope, otherwise team scope. The matching prefix targets ONLY the
 * `field-definitions:` sub-tree so the parent `organization:{id}` /
 * `team:{id}` row cache is preserved.
 */
export const invalidateFieldDefinitionsCache = async (data: {
  organizationId: string;
  teamId: string | null;
}): Promise<void> => {
  const prefix =
    data.teamId === null
      ? orgFieldDefsPrefix(data.organizationId)
      : teamFieldDefsPrefix(data.teamId);
  await deleteKeysByPrefix(prefix);
};

/**
 * Convenience invalidator for the team-scope sub-tree — used by
 * `duplicate-org-to-team` when the org-create / team-create hooks seed
 * the new team's definitions for the first time.
 */
export const invalidateTeamFieldDefinitionsCache = async (
  teamId: string,
): Promise<void> => {
  await deleteKeysByPrefix(teamFieldDefsPrefix(teamId));
};

/**
 * Cache key for the per-team locale read used by `apply-template` /
 * `list-templates`. Nested under `team:{teamId}:` for consistency.
 */
export const teamLocaleCacheKey = (teamId: string): string =>
  `team:${teamId}:locale`;
