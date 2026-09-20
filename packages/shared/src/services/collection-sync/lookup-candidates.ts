import { sql } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncSource } from "../../db/schema";
import { SYNC_LIMITS } from "../../schemas/collection-sync";

/**
 * "Which records should this `lookup` run refresh?" — five bounded queries, in
 * the order a person would pick.
 *
 * WHY FIVE AND NOT ONE. The first version asked it with a single statement:
 * a `LEFT JOIN` of the whole collection against the whole state table, sorted
 * by `ORDER BY CASE …, synced_at`. That is O(collection) per run, on a path a
 * record edit triggers interactively — so a 50 000-row collection sorted
 * 50 000 rows to pick 200, every fifteen minutes. Each query below is
 * `LIMIT remaining` against ONE index and stops the moment the list is full, so
 * a run costs what it takes and not what the collection is.
 *
 * The order is the priority, and each step earns its place:
 *  1. NAMED — somebody is waiting for these. `requestSyncRefresh` marks them
 *     `pending` too, so they would come back in (2) anyway; asking first is
 *     what makes the wait short.
 *  2. `pending` — an edit changed a bound field. Indexed by
 *     `record_sync_state_source_status_idx`.
 *  3. STALEST — ordinary rotation, by `record_sync_state_source_synced_idx`,
 *     and only rows past `rotateBefore` (see `lookupRotationFloor`).
 *  4. NEVER TRACKED, AT A CURSOR — the first pass over a collection. The
 *     cursor is what stops this being the O(collection) anti-join the sort
 *     used to be: once every record is tracked, the scan finishes, records the
 *     fact, and is not run again until the daily rescan. New records do not
 *     need it — a creation marks them `pending` (`invalidate-on-change.ts`).
 *  5. `missing`, RESTED — a row the app had no answer for, after
 *     `lookupMissingRetryMs`. Capped hard: these are the rows most likely to
 *     stay unanswered, and they must never crowd out the rotation.
 */

export interface LookupCandidate {
  recordId: string;
  contentHash: string | null;
}

/** `missing` rows one run may re-ask. Deliberately a floor's worth, not a share. */
const MISSING_RETRY_PER_RUN = 50;

/**
 * How stale a tracked row must be before the rotation spends a call on it.
 *
 * A `lookup` run does NOT only happen on its cadence. `invalidate-on-change`
 * sets `next_run_at = now()` whenever a bound column moves — an edit, a
 * creation, a `table` source rewriting the key — and the sweep then picks the
 * source up as an ordinary `schedule` run. Without a floor, step (3) filled
 * every such run to its limit with whatever happened to be stalest, so
 * creating five records cost two hundred upstream calls: five that were asked
 * for and a hundred and ninety-five that had been answered minutes earlier.
 * Nothing in the run said so — the counters read `unchanged: 195`, which is
 * what a well-behaved sync looks like.
 *
 * HALF the cadence, not the whole of it. At the whole interval a row refreshed
 * in the closing seconds of a long run is a hair too fresh when the next tick
 * starts, so it waits a full extra cycle and the rotation drifts to half speed.
 * Half leaves room for a run's own duration while still refusing a call on a
 * row answered moments ago, which is the case this exists for.
 *
 * A manual source is floored at the tightest cadence the product offers: it
 * has no interval of its own, and "only on demand" is the one setting where an
 * edit-triggered rotation is most clearly not what was asked for.
 */
export const lookupRotationFloor = (
  source: Pick<CollectionSyncSource, "schedule">,
  now: Date = new Date(),
): Date => {
  const everyMinutes =
    source.schedule.mode === "interval" &&
    source.schedule.everyMinutes !== undefined
      ? source.schedule.everyMinutes
      : SYNC_LIMITS.minIntervalMinutes;
  return new Date(now.getTime() - (everyMinutes * 60_000) / 2);
};

export const selectLookupCandidates = async (input: {
  source: CollectionSyncSource;
  limit: number;
  requested?: string[];
}): Promise<LookupCandidate[]> => {
  const { source } = input;
  const picked = new Map<string, LookupCandidate>();
  const remaining = (): number => input.limit - picked.size;

  const absorb = (rows: Record<string, unknown>[]): void => {
    for (const row of rows) {
      if (picked.size >= input.limit) return;
      const recordId = Reflect.get(row, "id");
      if (typeof recordId !== "string" || picked.has(recordId)) continue;
      const contentHash = Reflect.get(row, "content_hash");
      picked.set(recordId, {
        recordId,
        contentHash: typeof contentHash === "string" ? contentHash : null,
      });
    }
  };

  // (1) Named. Filtered to the source's own collection and team — the caller's
  // list is a request, not an authorisation.
  const requested = (input.requested ?? []).slice(0, input.limit);
  if (requested.length > 0) {
    const rows = await db.execute(sql`
      SELECT r.id::text     AS id,
             s.content_hash AS content_hash
        FROM collection_records r
        LEFT JOIN record_sync_state s
               ON s.record_id = r.id
              AND s.sync_source_id = ${source.id}::uuid
       WHERE r.id = ANY(${sql.param(requested)}::uuid[])
         AND r.team_id = ${source.teamId}::uuid
         AND r.collection_id = ${source.collectionId}::uuid`);
    absorb(rows.rows);
  }
  if (remaining() <= 0) return [...picked.values()];

  // (2) Queued by an edit.
  const pending = await db.execute(sql`
    SELECT s.record_id::text AS id,
           s.content_hash    AS content_hash
      FROM record_sync_state s
     WHERE s.sync_source_id = ${source.id}::uuid
       AND s.status = 'pending'::record_sync_status
     LIMIT ${remaining()}`);
  absorb(pending.rows);
  if (remaining() <= 0) return [...picked.values()];

  // (3) The stalest already-tracked rows that are actually due.
  const stalest = await db.execute(sql`
    SELECT s.record_id::text AS id,
           s.content_hash    AS content_hash
      FROM record_sync_state s
     WHERE s.sync_source_id = ${source.id}::uuid
       AND s.status IN ('ok'::record_sync_status, 'error'::record_sync_status)
       AND s.synced_at < ${lookupRotationFloor(source)}
     ORDER BY s.synced_at ASC
     LIMIT ${remaining()}`);
  absorb(stalest.rows);
  if (remaining() <= 0) return [...picked.values()];

  // (4) Never tracked, walked forward by record id.
  const scan = await scanUntracked({ source, limit: remaining() });
  absorb(scan);
  if (remaining() <= 0) return [...picked.values()];

  // (5) `missing`, rested.
  const rested = new Date(Date.now() - SYNC_LIMITS.lookupMissingRetryMs);
  const retry = await db.execute(sql`
    SELECT s.record_id::text AS id,
           s.content_hash    AS content_hash
      FROM record_sync_state s
     WHERE s.sync_source_id = ${source.id}::uuid
       AND s.status = 'missing'::record_sync_status
       AND s.synced_at < ${rested}
     ORDER BY s.synced_at ASC
     LIMIT ${Math.min(remaining(), MISSING_RETRY_PER_RUN)}`);
  absorb(retry.rows);

  return [...picked.values()];
};

/**
 * The untracked scan, and the cursor that makes it terminate.
 *
 * A short page means the walk reached the end of the collection: the cursor is
 * cleared and `untracked_scan_done_at` is stamped, so the next run skips this
 * step entirely until a day has passed. Without that stamp the anti-join runs
 * on every run for ever, finding nothing, having read the whole collection to
 * find it.
 */
const scanUntracked = async (input: {
  source: CollectionSyncSource;
  limit: number;
}): Promise<Record<string, unknown>[]> => {
  const { source } = input;
  const doneRecently =
    source.untrackedScanDoneAt !== null &&
    Date.now() - source.untrackedScanDoneAt.getTime() <
      SYNC_LIMITS.fullWalkIntervalMinutes * 60_000;
  if (doneRecently) return [];

  const after = source.untrackedScanCursor;
  const result = await db.execute(sql`
    SELECT r.id::text AS id
      FROM collection_records r
     WHERE r.collection_id = ${source.collectionId}::uuid
       AND r.team_id = ${source.teamId}::uuid
       AND r.status <> 'rejected'::ontology_status
       ${after === null ? sql`` : sql`AND r.id > ${after}::uuid`}
       AND NOT EXISTS (
         SELECT 1 FROM record_sync_state s
          WHERE s.record_id = r.id
            AND s.sync_source_id = ${source.id}::uuid
       )
     ORDER BY r.id ASC
     LIMIT ${input.limit}`);

  const rows = result.rows;
  const last =
    rows.length === 0 ? null : Reflect.get(rows[rows.length - 1] ?? {}, "id");
  const finished = rows.length < input.limit;
  await db.execute(sql`
    UPDATE collection_sync_sources
       SET untracked_scan_cursor = ${finished ? null : typeof last === "string" ? last : null},
           untracked_scan_done_at = ${finished ? sql`now()` : sql`untracked_scan_done_at`}
     WHERE id = ${source.id}::uuid`);

  return rows;
};
