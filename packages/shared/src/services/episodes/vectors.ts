import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { aiVectors } from "../../db/schema";

/**
 * Drop the recall-index rows of episodes (demotion, supersession). Direct
 * SQL — nothing to embed, no AI-service roundtrip. The episode rows stay:
 * re-promotion = re-vectorize (idempotent pipeline).
 */
export const deleteEpisodeVectors = async (
  episodeIds: string[],
): Promise<void> => {
  if (episodeIds.length === 0) return;
  await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "episodes"),
        inArray(aiVectors.sourceId, episodeIds),
      ),
    );
};
