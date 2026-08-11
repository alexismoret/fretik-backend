import { and, inArray, isNotNull, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import {
  analyzeObjectTable,
  dropAutoIndex,
  ensureColumnIndex,
  estimatedRowCount,
  INDEX_ROW_THRESHOLD,
  indexName,
  indexTargetsForType,
  listAutoIndexUsage,
} from "./indexes";

/**
 * The autonomous half of the index policy: build what a type needs, retire what
 * Postgres never reads, and rebuild on demand — with no human ever naming an
 * index.
 *
 * The loop, and why it needs both halves:
 *
 *   field exists ──▶ table crosses the row threshold ──▶ INDEX BUILT
 *                                                            │
 *                        ┌───────────────────────────────────┴─────────────┐
 *                  idx_scan > 0                                     idx_scan = 0
 *              (clears indexUnusedSince)                    (stamps indexUnusedSince)
 *                        │                                             │
 *                        │                                    UNUSED_GRACE_MS later
 *                        │                                             ▼
 *                        │                              DROP + stamps indexDroppedAt
 *                        │                                             │
 *                        └───── a query filters/sorts that field ◀──────┘
 *                               (clears indexDroppedAt, see `noteIndexWanted`)
 *
 * Without `indexDroppedAt` the two halves fight: reconciliation would rebuild,
 * on the very next pass, exactly what the pruning pass just dropped.
 */

/** Zero scans for this long and an index is not paying for its write cost. */
const UNUSED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build every missing index for a type — after a bulk load, not before it.
 *
 * Measured on 500k rows: loading with the indexes already in place takes 78 s,
 * loading bare and building afterwards takes 13 s + 30 s. Same end state, 1.8×
 * faster, which is why every caller of this runs once the rows are in.
 *
 * Below the row threshold this does nothing: a sequential scan of a few
 * thousand rows costs single-digit milliseconds, and most types never grow past
 * that. Returns the number of indexes created.
 */
export const reconcileFieldIndexes = async (input: {
  objectTypeId: string;
}): Promise<number> => {
  let rows = await estimatedRowCount(input.objectTypeId);
  if (rows < INDEX_ROW_THRESHOLD) {
    // "Too small" is the one verdict a STALE estimate can get catastrophically
    // wrong, and it is stale exactly when it matters: `reltuples` is refreshed
    // by autoanalyze, not by INSERT, so a table that just received 25 000 rows
    // still reads as the empty one it was — measured, and it skipped every
    // index. So the cheap verdict is never trusted on its own: refresh the
    // statistics and ask again. On a genuinely small table this costs a sampled
    // ANALYZE and the answer does not change.
    await analyzeObjectTable(input.objectTypeId);
    rows = await estimatedRowCount(input.objectTypeId);
    if (rows < INDEX_ROW_THRESHOLD) return 0;
  }

  const fields = await db.query.fieldDefinitions.findMany({
    where: { objectTypeId: input.objectTypeId },
  });
  const targets = indexTargetsForType(fields);
  if (targets.length === 0) return 0;

  const existing = new Set(
    (await listAutoIndexUsage(input.objectTypeId)).map((index) => index.name),
  );
  let created = 0;
  for (const target of targets) {
    if (existing.has(indexName(input.objectTypeId, target.column))) continue;
    // Sequential on purpose: `CREATE INDEX CONCURRENTLY` is IO-heavy, and firing
    // ten at once on one table would starve the writes it is meant not to block.
    await ensureColumnIndex({
      objectTypeId: input.objectTypeId,
      column: target.column,
      sqlType: target.sqlType,
    });
    created += 1;
  }
  return created;
};

/**
 * Retire the indexes Postgres has not read, and stamp the fields so
 * reconciliation leaves them alone until someone queries them again.
 *
 * `idx_scan` is the only honest signal here: it is Postgres' own counter, so no
 * application bookkeeping can drift from what the planner actually did. Note it
 * resets when statistics are reset — hence the long grace period, which makes a
 * reset cost at most one delayed decision rather than a wave of drops.
 */
/**
 * Sort the auto-indexes on one table into the three verdicts the pass acts on.
 *
 * `orphans` is the one that is easy to miss: an index this module created that
 * no CURRENT field wants. The usual cause is a field being DISABLED — the
 * column survives, so Postgres keeps the index, but the field stops being a
 * target, and without naming this case nothing would ever come back for it. A
 * deleted field needs no handling at all: dropping its column takes its indexes
 * with it.
 *
 * An orphan skips the grace period. The grace period asks "is this still read?"
 * — here the answer is already "there is nothing left to read it for".
 */
export const classifyAutoIndexes = (
  usage: { name: string; scans: number }[],
  fieldIdByIndexName: Map<string, string>,
): { scanned: string[]; idle: string[]; orphans: string[] } => {
  const scanned: string[] = [];
  const idle: string[] = [];
  const orphans: string[] = [];
  for (const index of usage) {
    const fieldId = fieldIdByIndexName.get(index.name);
    if (fieldId === undefined) orphans.push(index.name);
    else if (index.scans > 0) scanned.push(fieldId);
    else idle.push(fieldId);
  }
  return { scanned, idle, orphans };
};

export const pruneUnusedFieldIndexes = async (input: {
  objectTypeId: string;
  now?: Date;
}): Promise<string[]> => {
  const now = input.now ?? new Date();
  const usage = await listAutoIndexUsage(input.objectTypeId);
  if (usage.length === 0) return [];

  const fields = await db.query.fieldDefinitions.findMany({
    where: { objectTypeId: input.objectTypeId },
  });
  const byIndexName = new Map(
    indexTargetsForType(fields).map((target) => [
      indexName(input.objectTypeId, target.column),
      target.fieldId,
    ]),
  );

  const { scanned, idle, orphans } = classifyAutoIndexes(usage, byIndexName);

  const dropped: string[] = [];
  for (const name of orphans) {
    await dropAutoIndex(name);
    dropped.push(name);
  }

  // An index Postgres read since the last pass has proven itself — forget any
  // idleness we had recorded for it.
  if (scanned.length > 0) {
    await db
      .update(fieldDefinitions)
      .set({ indexUnusedSince: null })
      .where(
        and(
          inArray(fieldDefinitions.id, scanned),
          isNotNull(fieldDefinitions.indexUnusedSince),
        ),
      );
  }
  if (idle.length === 0) return dropped;

  // First observation of idleness starts the clock; later passes leave it be,
  // so the grace period measures elapsed time and not the number of passes.
  await db
    .update(fieldDefinitions)
    .set({ indexUnusedSince: now })
    .where(
      and(
        inArray(fieldDefinitions.id, idle),
        sql`${fieldDefinitions.indexUnusedSince} IS NULL`,
      ),
    );

  const expired = await db.query.fieldDefinitions.findMany({
    columns: { id: true },
    where: {
      id: { in: idle },
      indexUnusedSince: { lt: new Date(now.getTime() - UNUSED_GRACE_MS) },
    },
  });
  if (expired.length === 0) return dropped;

  const expiredIds = new Set(expired.map((field) => field.id));
  for (const [name, fieldId] of byIndexName) {
    if (!expiredIds.has(fieldId)) continue;
    await dropAutoIndex(name);
    dropped.push(name);
  }
  await db
    .update(fieldDefinitions)
    .set({ indexDroppedAt: now, indexUnusedSince: null })
    .where(inArray(fieldDefinitions.id, [...expiredIds]));
  return dropped;
};

/**
 * Mark that a dropped index is wanted again — the resurrection half of the loop.
 *
 * Called from the read paths with the field keys a query filtered, sorted or
 * grouped by. It writes only when one of them was actually dropped, which makes
 * it free in the normal case: the caller already holds the field definitions,
 * so "was this dropped" is a property lookup, not a query.
 *
 * Fire-and-forget by contract — a read must never fail, or wait, because
 * bookkeeping did.
 */
export const noteIndexWanted = (input: {
  fields: FieldDefinition[];
  keys: Iterable<string>;
}): void => {
  const wanted = new Set(input.keys);
  // The decisive part: the caller already holds these definitions (the read
  // paths load them anyway, through a cache), so the common case — nothing was
  // ever dropped — costs a set lookup and issues NO query at all. A write only
  // happens when a dropped index is genuinely wanted back.
  const revive = input.fields.filter(
    (field) => field.indexDroppedAt !== null && wanted.has(field.key),
  );
  if (revive.length === 0) return;
  void db
    .update(fieldDefinitions)
    .set({ indexDroppedAt: null, indexUnusedSince: null })
    .where(
      inArray(
        fieldDefinitions.id,
        revive.map((field) => field.id),
      ),
    )
    .catch(() => {
      // Intentionally silent: see the contract above.
    });
};

/**
 * Types the maintenance pass must visit, biggest first.
 *
 * TWO reasons to be on this list, and they matter in OPPOSITE directions:
 *
 * 1. The table is big enough to deserve indexes. This is the catch-all for a
 *    table that crossed the threshold by growing row by row — no import and no
 *    schema change to hang a hook on, just an insert a minute for a month.
 *    `reltuples` is enough here: autoanalyze tracks inserts, so a slowly
 *    growing table's estimate is current by the time it matters.
 *
 * 2. The table ALREADY CARRIES auto-created indexes, whatever its size now.
 *    Without this clause the system is one-way: a table that shrank back below
 *    the threshold — rows deleted one by one, an import rolled back, a type
 *    emptied and reused — would drop off the list entirely, and the pruning
 *    pass would never look at it again. Its indexes would outlive the rows they
 *    were built for, forever. The rule is that anything this module CREATED
 *    stays reachable by the pass that retires it.
 *
 * Retirement itself still turns on `idx_scan`, never on the row count: an index
 * on a table that shrank is cheap, and Postgres switching to sequential scans
 * is exactly what makes its scan counter stop moving. Small and used stays;
 * small and unread leaves after the grace period.
 *
 * The table name carries the type id with its dashes stripped
 * (`obj_<32 hex>`), so the uuid is rebuilt here rather than by loading every
 * object type and filtering in memory.
 */
export const objectTypesWorthIndexing = async (
  limit = 200,
): Promise<string[]> => {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT substring(h, 1, 8) || '-' || substring(h, 9, 4) || '-'
             || substring(h, 13, 4) || '-' || substring(h, 17, 4) || '-'
             || substring(h, 21, 12) AS id
        FROM (
          SELECT substring(c.relname from 5) AS h, c.reltuples AS n
          FROM pg_class c
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'data'
            AND c.relkind = 'r'
            AND c.relname ~ '^obj_[0-9a-f]{32}$'
            AND (
              c.reltuples >= ${INDEX_ROW_THRESHOLD}
              OR EXISTS (
                SELECT 1
                FROM pg_stat_user_indexes i
                WHERE i.relid = c.oid
                  AND i.indexrelname ~ ('^ix_' || substring(c.relname from 5) || '_[0-9a-f]{8}$')
              )
            )
        ) t
        ORDER BY n DESC
        LIMIT ${limit}`,
  );
  return rows.rows.map((row) => row.id);
};
