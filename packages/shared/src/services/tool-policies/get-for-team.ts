import db from "../../db";
import { selectOrCache } from "../../lib/redis";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import { teamToolPoliciesCacheKey } from "./cache";

/**
 * Read a team's builtin-tool policy map, Redis-cached for 30 min. Returns the
 * SPARSE `{ [toolName]: level }` map (empty `{}` when the team has never
 * customised anything — callers treat absent keys as "use the catalog
 * default"). Stored keys are returned raw; catalog validation happens at write
 * time and unknown keys are simply ignored at resolution.
 */
export const getTeamToolPolicies = async (
  teamId: string,
): Promise<Record<string, ToolPolicyLevel>> =>
  selectOrCache(
    () =>
      db.query.teamToolPolicies
        .findFirst({ where: { teamId } })
        .then((row) => row?.policies ?? {}),
    teamToolPoliciesCacheKey(teamId),
  );
