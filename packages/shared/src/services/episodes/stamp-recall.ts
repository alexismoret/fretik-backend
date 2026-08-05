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
      // Usage is not edition: pin updated_at, else the ORM's $onUpdateFn
      // refreshes it on every stamp and CONTENT recency starts tracking recall
      // usage — the compounding half of the recalled→boosted→recalled loop the
      // graph arm's RECALL_BOOST_CAP bounds (measured 2026-08-05).
      updatedAt: sql`${aiEpisodes.updatedAt}`,
    })
    .where(inArray(aiEpisodes.id, episodeIds));
};
