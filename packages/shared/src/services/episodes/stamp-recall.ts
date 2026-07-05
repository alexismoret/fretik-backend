import { inArray, sql } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";

/**
 * Stamp recall usage on the episodes a turn actually surfaced — the demotion
 * GC's freshness signal. One set-based UPDATE, fired-and-forgotten by the
 * recall pipeline (a lost stamp only delays demotion, never breaks recall).
 */
export const stampEpisodeRecall = async (
  episodeIds: string[],
): Promise<void> => {
  if (episodeIds.length === 0) return;
  await db
    .update(aiEpisodes)
    .set({
      lastRecalledAt: new Date(),
      recallCount: sql`${aiEpisodes.recallCount} + 1`,
    })
    .where(inArray(aiEpisodes.id, episodeIds));
};
