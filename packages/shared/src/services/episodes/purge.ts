import { sql } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";
import { deleteEpisodeVectors } from "./vectors";

/**
 * Hard-delete episodes that have been `demoted` for at least `olderThanDays`
 * — the final stage the demotion GC anticipates ("`demotedAt` stamps it for
 * an eventual much-later purge"). Covers both user-hidden and GC-cold-demoted
 * rows. Chunked (mirrors `demoteStaleEpisodes`); `ai_episode_records` cascades
 * on the episode FK, and vectors are dropped explicitly (idempotent — already
 * gone at demotion). Returns the number of rows removed.
 */
export const purgeExpiredEpisodes = async (input: {
  olderThanDays: number;
  limit: number;
}): Promise<{ purged: number }> => {
  let total = 0;
  for (;;) {
    const rows = await db
      .delete(aiEpisodes)
      .where(
        sql`${aiEpisodes.id} IN (
          SELECT id FROM ai_episodes
          WHERE state = 'demoted'
            AND demoted_at IS NOT NULL
            AND demoted_at < now() - make_interval(days => ${input.olderThanDays})
          LIMIT ${input.limit}
        )`,
      )
      .returning({ id: aiEpisodes.id });
    if (rows.length === 0) break;
    await deleteEpisodeVectors(rows.map((r) => r.id));
    total += rows.length;
    if (rows.length < input.limit) break;
  }
  return { purged: total };
};
