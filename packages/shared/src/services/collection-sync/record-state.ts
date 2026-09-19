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
 * The freshness of NAMED records, by primary key.
 *
 * Deliberately not "every record this source tracks": the caller always knows
 * which rows it is about to touch — a page of upstream ids, or the records a
 * refresh named — and reading the whole state table to answer a question about
 * two hundred of them is O(collection) on a path that runs every fifteen
 * minutes. The old whole-table loader was exactly that, on the INTERACTIVE
 * lookup path.
 */
export const loadRecordSyncStateFor = async (
  syncSourceId: string,
  recordIds: readonly string[],
): Promise<Map<string, RecordSyncStateRow>> => {
  const byRecordId = new Map<string, RecordSyncStateRow>();
  if (recordIds.length === 0) return byRecordId;

  for (const chunk of chunkForBulk([...new Set(recordIds)])) {
    const result = await db.execute(sql`
      SELECT s.record_id::text AS record_id,
             s.status::text     AS status,
             s.content_hash     AS content_hash
        FROM record_sync_state s
       WHERE s.sync_source_id = ${syncSourceId}::uuid
         AND s.record_id = ANY(${sql.param(chunk)}::uuid[])`);
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
 * The left side of ONE PAGE's diff: the records this source owns whose upstream
 * id is in the page just read.
 *
 * Scoped to the page, and that is the whole memory argument of the streaming
 * runner. The first version loaded every record the source owned into a Map
 * keyed by external id — 150-200 MB at a million rows, rebuilt from scratch by
 * any leg that resumed in another process. This asks the same question of the
 * same unique index (`collection_records_sync_external_uniq`) five hundred ids
 * at a time, and nothing survives the page.
 *
 * A `LEFT JOIN` rather than an inner one: the record and its freshness row are
 * written by two statements, so a run that died between them left a record with
 * no state. Joining them away would make that record invisible to the next run,
 * which would then CREATE it a second time and hit the upsert index. Seen as
 * `contentHash: null`, it simply looks like a row that has changed.
 */
export const loadTableSyncIndexFor = async (
  syncSourceId: string,
  externalIds: readonly string[],
): Promise<Map<string, TableSyncIndexEntry>> => {
  const byExternalId = new Map<string, TableSyncIndexEntry>();
  if (externalIds.length === 0) return byExternalId;

  for (const chunk of chunkForBulk([...new Set(externalIds)])) {
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
         AND r.external_id = ANY(${sql.param(chunk)}::text[])`);
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
  }
  return byExternalId;
};

/**
 * "I saw this row, and it had not changed" — the stamp the orphan bracket
 * reads.
 *
 * An unchanged row costs no UPDATE and no journal entry, which is the whole
 * point of the content hash; but it must still leave a mark, because the
 * bracket asks "which of the records I track did this walk NOT see" and
 * answers it with `synced_at < walkStartedAt`. Without this every unchanged
 * row would look like an orphan and a healthy sync would reject its own
 * collection.
 *
 * Only the timestamp moves: the status and the hash are already right, and
 * rewriting them would be a wider row version for nothing.
 */
export const touchRecordSyncState = async (
  syncSourceId: string,
  recordIds: readonly string[],
): Promise<void> => {
  if (recordIds.length === 0) return;
  for (const chunk of chunkForBulk([...recordIds])) {
    await db.execute(sql`
      UPDATE record_sync_state
         SET synced_at = now()
       WHERE sync_source_id = ${syncSourceId}::uuid
         AND record_id = ANY(${sql.param(chunk)}::uuid[])`);
  }
};
