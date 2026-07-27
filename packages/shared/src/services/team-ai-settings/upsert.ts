import db from "../../db";
import { type TeamAiSettings, teamAiSettings } from "../../db/schema";
import type { ReasoningLevelInput } from "../../schemas/reasoning";
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
 *
 * ONE derived rule lives here rather than in the handler, so every caller gets
 * it: changing the flagship model CLEARS `flagshipReasoningLevel`. A thinking
 * depth is chosen against a specific model — its cost, its latency, its effort
 * ladder — so carrying "xhigh" from Luna over to a model whose ladder stops at
 * "high" would pin a level the new model rejects. After a model change the team
 * is back on that model's own default until they choose again.
 */
export const upsertTeamAiSettings = async (data: {
  teamId: string;
  flagshipProfileKey?: TierOverride;
  workhorseProfileKey?: TierOverride;
  utilityProfileKey?: TierOverride;
  /** `ReasoningLevel` for the flagship model; `null` resets to its default. */
  flagshipReasoningLevel?: ReasoningLevelInput | null | undefined;
}): Promise<TeamAiSettings> => {
  const {
    teamId,
    flagshipProfileKey,
    workhorseProfileKey,
    utilityProfileKey,
    flagshipReasoningLevel,
  } = data;

  // Uncached read on purpose — the reset rule below compares against the row
  // as it actually stands, not a possibly-stale cached copy.
  const existing = await db.query.teamAiSettings.findFirst({
    where: { teamId },
  });

  // An explicit level always wins; otherwise a flagship change to a DIFFERENT
  // model clears it. Re-picking the model already in effect is a no-op, so a
  // double-click in the hub can't silently wipe a deliberate choice.
  const flagshipChanged =
    flagshipProfileKey !== undefined &&
    (flagshipProfileKey ?? null) !== (existing?.flagshipProfileKey ?? null);
  const reasoningLevel =
    flagshipReasoningLevel !== undefined
      ? flagshipReasoningLevel
      : flagshipChanged
        ? null
        : undefined;

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
  if (reasoningLevel !== undefined) set.flagshipReasoningLevel = reasoningLevel;

  const [row] = await db
    .insert(teamAiSettings)
    .values({
      teamId,
      flagshipProfileKey: flagshipProfileKey ?? null,
      workhorseProfileKey: workhorseProfileKey ?? null,
      utilityProfileKey: utilityProfileKey ?? null,
      flagshipReasoningLevel: flagshipReasoningLevel ?? null,
    })
    .onConflictDoUpdate({ target: teamAiSettings.teamId, set })
    .returning();

  if (!row) throw new Error("Failed to upsert team AI settings");

  await invalidateTeamAiSettingsCache(teamId);
  return row;
};
