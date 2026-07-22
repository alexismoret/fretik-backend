import { SYSTEM_ACTOR } from "@fretik/shared/services/domain-events/emit";
import { emitDomainEventsBulk } from "@fretik/shared/services/domain-events/emit-bulk";
import { demoteStaleEpisodes } from "@fretik/shared/services/episodes/demote";
import { purgeExpiredEpisodes } from "@fretik/shared/services/episodes/purge";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";

/**
 * Episode GC (P6) — the 04:00 cron. Two stages:
 *   1. Active episodes not recalled for `DEMOTE_*_DAYS` flip to `demoted`
 *      (stamped `demotedAt`) and leave the recall index (vectors deleted).
 *   2. Anything `demoted` for ≥ `PURGE_AFTER_DAYS` is finally HARD-deleted —
 *      the "eventual much-later purge" the demotion has always anticipated,
 *      covering both cold GC-demoted rows and user-hidden ones.
 * Chunked SQL, no LLM — fast enough for the maintenance dispatcher.
 */

/** Retention floor (never-recalled) and ceiling (well-recalled) in days. */
const DEMOTE_BASE_DAYS = 90;
const DEMOTE_KEEP_DAYS = 180;
/** A demoted episode is hard-deleted once it has been out this long. */
const PURGE_AFTER_DAYS = 30;
const BATCH = 200;

export const runGcDemote = async (): Promise<{
  demoted: number;
  purged: number;
}> => {
  const date = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (;;) {
    const batch = await demoteStaleEpisodes({
      baseDays: DEMOTE_BASE_DAYS,
      keepDays: DEMOTE_KEEP_DAYS,
      limit: BATCH,
    });
    if (batch.length === 0) break;
    await deleteEpisodeVectors(batch.map((e) => e.id));

    // Journal the demotions, one bulk emit per team. The dedup key carries
    // the run date: a future re-promote → re-demote cycle stays journalable.
    const byTeam = new Map<
      string,
      { organizationId: string; episodes: typeof batch }
    >();
    for (const episode of batch) {
      const group = byTeam.get(episode.teamId) ?? {
        organizationId: episode.organizationId,
        episodes: [],
      };
      group.episodes.push(episode);
      byTeam.set(episode.teamId, group);
    }
    for (const [teamId, group] of byTeam) {
      await emitDomainEventsBulk({
        organizationId: group.organizationId,
        teamId,
        actor: SYSTEM_ACTOR,
        events: group.episodes.map((e) => ({
          type: "episode.demoted",
          subjectType: "episode",
          payload: { episodeId: e.id, title: e.title },
          dedupKey: `episode.demoted:${e.id}:${date}`,
        })),
      });
    }

    total += batch.length;
    if (batch.length < BATCH) break;
  }

  // Stage 2: hard-delete episodes demoted long enough. Runs after the demote
  // pass so a freshly-cold episode gets its full 30-day grace, never same-run.
  const { purged } = await purgeExpiredEpisodes({
    olderThanDays: PURGE_AFTER_DAYS,
    limit: BATCH,
  });

  return { demoted: total, purged };
};
