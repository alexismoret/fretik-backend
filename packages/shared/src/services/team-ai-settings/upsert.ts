import db from "../../db";
import { type TeamAiSettings, teamAiSettings } from "../../db/schema";
import { invalidateTeamAiSettingsCache } from "./cache";

/**
 * Per-tier override to write. `string` pins a profile key, `null` resets the
 * tier to the code default, `undefined` leaves the stored value untouched.
 */
type TierOverride = string | null | undefined;

/**
 * Create or update a team's AI model selection (chantier C8). Validation of
 * the profile keys against the registry is the caller's job (`@fretik/ai`
 * `isSelectableForTier`) — this service only persists + invalidates the
 * cache. Only the fields the caller provides (not `undefined`) are written.
 */
export const upsertTeamAiSettings = async (data: {
  teamId: string;
  flagshipProfileKey?: TierOverride;
  workhorseProfileKey?: TierOverride;
  utilityProfileKey?: TierOverride;
}): Promise<TeamAiSettings> => {
  const { teamId, flagshipProfileKey, workhorseProfileKey, utilityProfileKey } =
    data;

  // Build the on-conflict SET from only the supplied tiers, so a partial
  // write never clobbers a tier the caller didn't mention.
  const set: Partial<typeof teamAiSettings.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (flagshipProfileKey !== undefined)
    set.flagshipProfileKey = flagshipProfileKey;
  if (workhorseProfileKey !== undefined)
    set.workhorseProfileKey = workhorseProfileKey;
  if (utilityProfileKey !== undefined)
    set.utilityProfileKey = utilityProfileKey;

  const [row] = await db
    .insert(teamAiSettings)
    .values({
      teamId,
      flagshipProfileKey: flagshipProfileKey ?? null,
      workhorseProfileKey: workhorseProfileKey ?? null,
      utilityProfileKey: utilityProfileKey ?? null,
    })
    .onConflictDoUpdate({ target: teamAiSettings.teamId, set })
    .returning();

  if (!row) throw new Error("Failed to upsert team AI settings");

  await invalidateTeamAiSettingsCache(teamId);
  return row;
};
