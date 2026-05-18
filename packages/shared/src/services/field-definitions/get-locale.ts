import db from "../../db";
import { selectOrCache } from "../../lib/redis";
import { teamLocaleCacheKey } from "./cache";

/**
 * Resolve the i18n locale code to use when seeding template content for a
 * team. Reads `teamSettings.lang` (default `"en"`). Used by `apply-template`
 * and `duplicate-org-to-team` so the apply layer produces text in the
 * team's working language without the caller having to pass it explicitly.
 *
 * Cached under `team:{teamId}:locale` (30 min TTL). Invalidation is the
 * responsibility of the team-settings update flow when it touches `lang`
 * — that flow doesn't exist yet, so the worst case is a 30-min delay
 * between language change and reflected template seeding.
 *
 * For org-scope operations (no team context yet — e.g. at organization
 * creation), callers default to `"en"` directly.
 */
export const getTeamLocale = async (teamId: string): Promise<string> => {
  const settings = await selectOrCache(
    () =>
      db.query.teamSettings.findFirst({
        columns: { lang: true },
        where: { teamId },
      }),
    teamLocaleCacheKey(teamId),
  );
  return settings?.lang ?? "en";
};
