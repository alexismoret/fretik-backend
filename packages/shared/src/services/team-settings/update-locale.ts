import { eq } from "drizzle-orm";

import db from "../../db";
import { teamSettings } from "../../db/schema";
import { deleteKeysByPrefix } from "../../lib/redis";
import { teamLocaleCacheKey } from "../field-definitions/cache";

/**
 * Update a team's working UI language (`team_settings.lang`) and invalidate
 * the `team:{teamId}:locale` cache so `getTeamLocale` reflects the change
 * immediately. This is the write flow the `getTeamLocale` cache comment
 * referred to as "doesn't exist yet".
 *
 * Changing the team language sets the default for NEW members and localizes
 * team-scoped emails/templates — it does NOT change any existing member's
 * personal `user.language`.
 */
export const updateTeamLocale = async (
  teamId: string,
  lang: string,
): Promise<void> => {
  await db
    .update(teamSettings)
    .set({ lang })
    .where(eq(teamSettings.teamId, teamId));

  await deleteKeysByPrefix(teamLocaleCacheKey(teamId));
};
