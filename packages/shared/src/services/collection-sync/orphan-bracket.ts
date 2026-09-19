import { sql } from "drizzle-orm";
import db from "../../db";
import { SYNC_LIMITS } from "../../schemas/collection-sync";

/**
 * The bracket around a full walk: which records this source tracks that the
 * walk did not see, how many that is, and whether that number is believable.
 *
 * TWO RULES DECIDE EVERYTHING HERE, and both come from the same observation —
 * an upstream answer cannot tell "this row was deleted" apart from "this row
 * was not in what I asked for".
 *
 *  1. ONLY A FULL WALK MAY DIFF. An incremental read (`{"$since": true}`) is
 *     handed the rows that changed and nothing else, so every untouched record
 *     is absent from it. Diffing that answer marks the whole collection
 *     missing, and under `delete` empties it. Nango reaches the same conclusion
 *     from the other end: its deletion detection is off by default and runs
 *     only between an explicit `trackDeletesStart`/`End`, which is what
 *     `walkStartedAt` is here.
 *  2. PAST A THRESHOLD, NOBODY MAY DIFF. A filter narrowing upstream, a
 *     permission change, a date window rolling and a genuine mass deletion all
 *     produce the same short answer. So a walk that would orphan more than
 *     `orphanFloorRatio` of what the source tracks applies NO policy, ends
 *     `partial`, and asks a person to confirm — which is the one piece of
 *     information the answer itself could never carry.
 *
 * The floor covers `keep` too, and deliberately: `keep` is not destructive, but
 * a collection where nine rows in ten suddenly read `missing` is a lie of the
 * same size, and the confirmation is exactly as informative.
 */

/** Rows the source tracks, and how many of them this walk did not see. */
export interface OrphanCensus {
  /** Records with a `record_sync_state` row for this source, `missing` aside. */
  tracked: number;
  /** Of those, the ones this walk never touched. */
  newOrphans: number;
}

/**
 * Count both sides in ONE query, without materialising an id.
 *
 * `synced_at < walkStartedAt` is the whole test, and it works because BOTH
 * clocks are the database's: `walkStartedAt` is `collection_sync_runs.started_at`
 * (a `now()`), and every row the walk touched was stamped by a `now()` after
 * it. A timestamp taken in the worker would be the application's clock compared
 * against Postgres's, which differ by more than a page takes to write.
 *
 * Records already `missing` are excluded from both counts. If they were not,
 * a source sitting at 30% legitimately-missing rows under `keep` would trip
 * the floor on every single run and never sync again.
 *
 * The join is a LEFT one, from the RECORDS: a run that died between inserting
 * a record and writing its freshness row leaves a record with no state, and
 * that record is as much an orphan candidate as one whose stamp is old. An
 * inner join would quietly exclude it from both counts — and therefore from the
 * ratio the floor is computed on.
 */
export const countNewOrphans = async (input: {
  syncSourceId: string;
  walkStartedAt: Date;
}): Promise<OrphanCensus> => {
  const result = await db.execute(sql`
    SELECT count(*)::int AS tracked,
           count(*) FILTER (
             WHERE s.record_id IS NULL
                OR s.synced_at < ${input.walkStartedAt}
           )::int AS new_orphans
      FROM collection_records r
      LEFT JOIN record_sync_state s
             ON s.record_id = r.id
            AND s.sync_source_id = ${input.syncSourceId}::uuid
     WHERE r.sync_source_id = ${input.syncSourceId}::uuid
       AND s.status IS DISTINCT FROM 'missing'::record_sync_status`);

  const row = result.rows[0];
  const tracked = Reflect.get(row ?? {}, "tracked");
  const newOrphans = Reflect.get(row ?? {}, "new_orphans");
  return {
    tracked: typeof tracked === "number" ? tracked : 0,
    newOrphans: typeof newOrphans === "number" ? newOrphans : 0,
  };
};

/**
 * Is this census too large to act on?
 *
 * Two triggers, not one. The ratio is the general case; the equality is the
 * empty answer, which the ratio alone would miss on a collection of three rows
 * (3 > 0.2×3 is true, but 3 ≥ 20 is not) — and "the app answered nothing" is
 * the single most common way a misconfigured argument shows up.
 */
export const hitsOrphanFloor = (census: OrphanCensus): boolean => {
  if (census.newOrphans === 0) return false;
  if (census.tracked > 0 && census.newOrphans === census.tracked) return true;
  return (
    census.newOrphans > SYNC_LIMITS.orphanFloorRatio * census.tracked &&
    census.newOrphans >= SYNC_LIMITS.orphanFloorMinRows
  );
};

/** The sentence a person reads before confirming. Numbers, then the offer. */
export const orphanFloorReason = (census: OrphanCensus): string =>
  `the app answered with ${String(census.tracked - census.newOrphans)} of the ${String(census.tracked)} rows this collection tracks — nothing was rejected or deleted. Confirm a full resync to apply the orphan policy anyway.`;

/**
 * One page of orphan ids, walked forward by record id.
 *
 * Paged rather than returned whole because the policy is applied to them and
 * `delete` on 200 000 orphans would otherwise hold 200 000 uuids in memory to
 * hand to a chunker that immediately splits them again. The cursor is the
 * record id — v7, so time-ordered, unique, and exactly round-trippable (see
 * `lib/cursor.ts`).
 */
export const listOrphanIds = async (input: {
  syncSourceId: string;
  walkStartedAt: Date;
  after: string | null;
  limit: number;
}): Promise<string[]> => {
  const result = await db.execute(sql`
    SELECT r.id::text AS record_id
      FROM collection_records r
      LEFT JOIN record_sync_state s
             ON s.record_id = r.id
            AND s.sync_source_id = ${input.syncSourceId}::uuid
     WHERE r.sync_source_id = ${input.syncSourceId}::uuid
       AND s.status IS DISTINCT FROM 'missing'::record_sync_status
       AND (s.record_id IS NULL OR s.synced_at < ${input.walkStartedAt})
       ${input.after === null ? sql`` : sql`AND r.id > ${input.after}::uuid`}
     ORDER BY r.id
     LIMIT ${input.limit}`);
  return result.rows.flatMap((row) => {
    const recordId = Reflect.get(row, "record_id");
    return typeof recordId === "string" ? [recordId] : [];
  });
};
