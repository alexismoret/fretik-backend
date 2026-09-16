import { sql } from "drizzle-orm";
import db from "../../db";
import type { RecordSyncStatus } from "../../db/schema";
import { chunkForBulk, chunkSizeForParams } from "../../lib/db-bulk";

/**
 * `record_sync_state` — read and written set-based, never row by row.
 *
 * This is the table the whole engine's cost rests on. It answers two questions
 * with one indexed read each: "has this row changed since I last saw it"
 * (`contentHash`) and "what should I refresh next" (`status` + `syncedAt`). A
 * per-record round trip here would cost more than the upstream call it exists
 * to avoid.
 */

/** Columns one upsert binds per row — sizes the chunk, see `db-bulk`. */
const STATE_PARAMS_PER_ROW = 5;

export interface RecordSyncStateRow {
  recordId: string;
  status: RecordSyncStatus;
  contentHash: string | null;
}

/**
 * Every record this source tracks, in ONE query.
 *
 * Deliberately the whole set rather than a lookup per row: a `table` run has to
 * partition new / changed / unchanged / missing, which is a full outer join
 * between the upstream answer and this table, and doing it in memory over one
 * read is the difference between a 10 000-row sync costing one query and
 * costing 10 000.
 */
export const loadRecordSyncState = async (
  syncSourceId: string,
): Promise<Map<string, RecordSyncStateRow>> => {
  const result = await db.execute(sql`
    SELECT s.record_id::text AS record_id,
           s.status::text     AS status,
           s.content_hash     AS content_hash
      FROM record_sync_state s
     WHERE s.sync_source_id = ${syncSourceId}::uuid`);

  const byRecordId = new Map<string, RecordSyncStateRow>();
  for (const row of result.rows) {
    const recordId = Reflect.get(row, "record_id");
    const status = Reflect.get(row, "status");
    const contentHash = Reflect.get(row, "content_hash");
    if (typeof recordId !== "string" || !isRecordSyncStatus(status)) continue;
    byRecordId.set(recordId, {
      recordId,
      status,
      contentHash: typeof contentHash === "string" ? contentHash : null,
    });
  }
  return byRecordId;
};

const STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "error",
  "missing",
  "pending",
]);

const isRecordSyncStatus = (value: unknown): value is RecordSyncStatus =>
  typeof value === "string" && STATUSES.has(value);

export interface RecordSyncStateWrite {
  recordId: string;
  status: RecordSyncStatus;
  contentHash?: string | null;
  error?: string | null;
  /** True when this attempt failed — `attempts` counts failures, not passes. */
  failed?: boolean;
}

/**
 * Write the freshness of many records at once.
 *
 * `attempts` accumulates on the existing row rather than being sent: a failure
 * increments it and a success resets it, which is what makes "this row has been
 * failing for four runs" readable without a second table.
 */
export const upsertRecordSyncState = async (
  syncSourceId: string,
  rows: readonly RecordSyncStateWrite[],
): Promise<void> => {
  if (rows.length === 0) return;
  for (const chunk of chunkForBulk(
    [...rows],
    chunkSizeForParams(STATE_PARAMS_PER_ROW),
  )) {
    const tuples = chunk.map(
      (row) =>
        sql`(${row.recordId}::uuid, ${row.status}::record_sync_status, ${row.contentHash ?? null}::varchar, ${row.error ?? null}::text, ${row.failed === true}::boolean)`,
    );
    await db.execute(sql`
      INSERT INTO record_sync_state
        (record_id, sync_source_id, status, content_hash, error, attempts, synced_at)
      SELECT v.record_id, ${syncSourceId}::uuid, v.status, v.content_hash,
             v.error, CASE WHEN v.failed THEN 1 ELSE 0 END, now()
        FROM (VALUES ${sql.join(tuples, sql`, `)})
          AS v(record_id, status, content_hash, error, failed)
      ON CONFLICT (record_id, sync_source_id) DO UPDATE
         SET status = EXCLUDED.status,
             -- COALESCE, not assignment: a row marked 'missing' or 'error'
             -- carries no hash, and overwriting the last known one would make
             -- the row look CHANGED when it comes back and cost a pointless
             -- UPDATE (plus its journal entry and its re-embedding).
             content_hash = COALESCE(EXCLUDED.content_hash,
                                     record_sync_state.content_hash),
             error = EXCLUDED.error,
             attempts = CASE WHEN EXCLUDED.attempts > 0
                             THEN record_sync_state.attempts + 1
                             ELSE 0 END,
             synced_at = now()`);
  }
};

/**
 * Queue records for the next `lookup` run.
 *
 * `synced_at` is NOT touched on an existing row: it is the staleness order the
 * runner picks by, and bumping it here would send a row that was just marked
 * urgent to the back of its own queue. `pending` is ordered ahead of everything
 * regardless (see `run-lookup-sync.ts`), so a freshly-inserted row's `now()`
 * does not hide it either.
 */
export const markRecordsPending = async (
  syncSourceId: string,
  recordIds: readonly string[],
): Promise<number> => {
  if (recordIds.length === 0) return 0;
  const result = await db.execute(sql`
    INSERT INTO record_sync_state (record_id, sync_source_id, status, synced_at)
    SELECT t.id, ${syncSourceId}::uuid, 'pending'::record_sync_status, now()
      FROM unnest(${sql.param([...recordIds])}::uuid[]) AS t(id)
     WHERE EXISTS (SELECT 1 FROM collection_records r WHERE r.id = t.id)
    ON CONFLICT (record_id, sync_source_id) DO UPDATE
       SET status = 'pending'::record_sync_status
    RETURNING record_id`);
  return result.rows.length;
};

export interface TableSyncIndexEntry {
  recordId: string;
  contentHash: string | null;
  status: RecordSyncStatus | null;
}

/**
 * Every record a `table` source owns, keyed by the upstream id that identifies
 * it — the whole left side of a run's diff, in ONE query.
 *
 * A `LEFT JOIN` rather than an inner one: the record and its freshness row are
 * written by two statements, so a run that died between them left a record with
 * no state. Joining them away would make that record invisible to the next run,
 * which would then CREATE it a second time and hit the upsert index. Seen as
 * `contentHash: null`, it simply looks like a row that has changed.
 */
export const loadTableSyncIndex = async (
  syncSourceId: string,
): Promise<Map<string, TableSyncIndexEntry>> => {
  const result = await db.execute(sql`
    SELECT r.id::text     AS record_id,
           r.external_id  AS external_id,
           s.content_hash AS content_hash,
           s.status::text AS status
      FROM collection_records r
      LEFT JOIN record_sync_state s
             ON s.record_id = r.id
            AND s.sync_source_id = ${syncSourceId}::uuid
     WHERE r.sync_source_id = ${syncSourceId}::uuid
       AND r.external_id IS NOT NULL`);

  const byExternalId = new Map<string, TableSyncIndexEntry>();
  for (const row of result.rows) {
    const recordId = Reflect.get(row, "record_id");
    const externalId = Reflect.get(row, "external_id");
    const contentHash = Reflect.get(row, "content_hash");
    const status = Reflect.get(row, "status");
    if (typeof recordId !== "string" || typeof externalId !== "string")
      continue;
    byExternalId.set(externalId, {
      recordId,
      contentHash: typeof contentHash === "string" ? contentHash : null,
      status: isRecordSyncStatus(status) ? status : null,
    });
  }
  return byExternalId;
};
