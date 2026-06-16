import { deleteKeysByPrefix } from "../../lib/redis";

/**
 * Cache key + invalidation for `team_ai_settings` (chantier C8).
 *
 * Nested under the same `team:{teamId}:` scope used by `auth-middleware.ts`
 * and the field-definitions cache, so a `deleteKeysByPrefix` of the
 * `:ai-settings` segment wipes the entry without dropping the team row
 * itself from cache. One value per team (not a multi-variant tree), but the
 * prefix shape stays consistent with the rest of the codebase.
 */
export const teamAiSettingsCacheKey = (teamId: string): string =>
  `team:${teamId}:ai-settings`;

/**
 * Drop the cached settings for a team. Called by `upsert` AFTER the DB write
 * commits — never inside the transaction.
 */
export const invalidateTeamAiSettingsCache = async (
  teamId: string,
): Promise<void> => {
  await deleteKeysByPrefix(teamAiSettingsCacheKey(teamId));
};
