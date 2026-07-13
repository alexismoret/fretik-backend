import { deleteKeysByPrefix } from "../../lib/redis";

/**
 * Cache key + invalidation for `team_tool_policies`.
 *
 * Nested under the same `team:{teamId}:` scope as the auth middleware and the
 * AI-settings cache, so a `deleteKeysByPrefix` of the `:tool-policies` segment
 * wipes the entry without dropping the team's other cached values. One value
 * per team. Read by BOTH the API process (settings + dispatch enforcement) and
 * the AI process (prepareStep gate) through the same Redis, so an edit applies
 * on every instance's next turn.
 */
export const teamToolPoliciesCacheKey = (teamId: string): string =>
  `team:${teamId}:tool-policies`;

/**
 * Drop the cached policies for a team. Called by `upsert` AFTER the DB write
 * commits — never inside the transaction.
 */
export const invalidateTeamToolPoliciesCache = async (
  teamId: string,
): Promise<void> => {
  await deleteKeysByPrefix(teamToolPoliciesCacheKey(teamId));
};
