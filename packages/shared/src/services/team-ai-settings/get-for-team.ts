import db from "../../db";
import type { TeamAiSettings } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { teamAiSettingsCacheKey } from "./cache";

/**
 * Read a team's AI model selection (chantier C8), Redis-cached for 30 min.
 * Returns `null` when the team has never customised its models — callers
 * treat that as "use the code defaults". Profile keys are returned raw;
 * registry validation happens at resolution time in `@fretik/ai`.
 */
export const getTeamAiSettings = async (
  teamId: string,
): Promise<TeamAiSettings | null> =>
  selectOrCache(
    () =>
      db.query.teamAiSettings
        .findFirst({ where: { teamId } })
        .then((row) => row ?? null),
    teamAiSettingsCacheKey(teamId),
  );
