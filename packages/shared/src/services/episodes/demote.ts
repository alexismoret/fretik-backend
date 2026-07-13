import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { aiEpisodes } from "../../db/schema";

/**
 * Flip stale active episodes to `demoted` — they leave the recall index (the
 * caller deletes their `ai_vectors` rows) but the rows stay, `demotedAt`
 * stamping them for an eventual much-later purge. Freshness = last recall,
 * falling back to creation. Chunked via `limit`; the GC cron loops until it
 * returns fewer than `limit` rows.
 *
 * Retention is usage-weighted (MemoryBank-style): a never-recalled episode
 * expires at `baseDays`; each recall (capped at `MAX_BOOST_RECALLS`) buys a
 * linear slice more, up to `keepDays` for a well-used one — noise ("reformate
 * ce tableau") demotes fast, a repeatedly-recalled episode lingers. No LLM
 * importance scalar (LUFY: usage signals beat a static score).
 */

/** Recalls beyond this stop extending retention. */
const MAX_BOOST_RECALLS = 3;

export const demoteStaleEpisodes = async (input: {
  baseDays: number;
  keepDays: number;
  limit: number;
}): Promise<
  { id: string; teamId: string; organizationId: string; title: string }[]
> => {
  // Linear boost per recall, integer days for make_interval: base→keep across
  // MAX_BOOST_RECALLS (90/180/3 → +30/recall: 0→90, 1→120, 2→150, 3+→180).
  const perRecallBoostDays = Math.round(
    (input.keepDays - input.baseDays) / MAX_BOOST_RECALLS,
  );
  // Whole predicate inlined in ONE sql template (no nested fragment) so the
  // subquery renders unambiguously.
  const rows = await db
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(
      and(
        eq(aiEpisodes.state, "active"),
        sql`${aiEpisodes.id} IN (
          SELECT id FROM ai_episodes
          WHERE state = 'active'
            AND coalesce(last_recalled_at, created_at) < now() - make_interval(days => ${input.baseDays} + least(recall_count, ${MAX_BOOST_RECALLS}) * ${perRecallBoostDays})
          LIMIT ${input.limit}
        )`,
      ),
    )
    .returning({
      id: aiEpisodes.id,
      teamId: aiEpisodes.teamId,
      organizationId: aiEpisodes.organizationId,
      title: aiEpisodes.title,
    });
  return rows;
};
