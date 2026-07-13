import { SYSTEM_ACTOR } from "@fretik/shared/services/domain-events/emit";
import { emitDomainEventsBulk } from "@fretik/shared/services/domain-events/emit-bulk";
import { demoteStaleEpisodes } from "@fretik/shared/services/episodes/demote";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";

/**
 * Episode GC (P6) — the 04:00 cron. Active episodes not recalled for
 * `DEMOTE_AFTER_DAYS` flip to `demoted` (stamped `demotedAt` for an eventual
 * much-later purge) and leave the recall index (vectors deleted). Nothing is
 * ever deleted from `ai_episodes`; re-promotion = flip back + re-vectorize.
 * Chunked SQL, no LLM — fast enough for the maintenance dispatcher.
 */

/** Retention floor (never-recalled) and ceiling (well-recalled) in days. */
const DEMOTE_BASE_DAYS = 90;
const DEMOTE_KEEP_DAYS = 180;
const BATCH = 200;

export const runGcDemote = async (): Promise<{ demoted: number }> => {
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
  return { demoted: total };
};
