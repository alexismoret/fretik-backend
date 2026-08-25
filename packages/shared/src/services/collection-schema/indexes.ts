import { sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { columnsForField, isVirtualField } from "./columns";
import {
  collectionTableName,
  MAX_PG_IDENT,
  qualifiedCollectionTable,
  SYS_COL,
} from "./identifiers";

/**
 * Per-field indexes on the extension tables — created on DEMAND, from what a
 * page actually queries.
 *
 * Why this exists: an extension table ships with ONE index, `(_team_id,
 * _status)`. That serves tenancy, and nothing else. Measured on 200k rows,
 * sorting a list by a typed field took 1714 ms through the old correlated
 * subquery and 460 ms once joined — but 28 ms with a `(_team_id, _status,
 * <col>)` index, because only then can Postgres walk the index in the sort's
 * order instead of sorting the whole team's rows. The leading two columns are
 * not decoration: without an equality on them the index cannot be entered.
 *
 * Why on demand and not per field: indexing all 30 fields of a type when 3 are
 * ever filtered is write amplification on every insert for no read. A page
 * declares exactly what it sorts, filters and groups by, so a saved page is the
 * honest signal.
 *
 * Why CONCURRENTLY: building an index takes a lock that would block writes for
 * the duration on a large table. `CONCURRENTLY` cannot run inside a
 * transaction, which is why this module owns its own statements and is never
 * handed a `tx` — unlike `table.ts`, whose DDL joins the caller's transaction.
 */

/** Postgres index methods this module knows how to build. */
type IndexMethod = "btree" | "btree_prefix" | "gin_array";

/**
 * How many characters of a text column the index keys on.
 *
 * A btree tuple cannot exceed 2704 bytes — measured here, a 2700 random-char
 * value raises `index row size 2744 exceeds btree version 4 maximum 2704` **on
 * INSERT**, so indexing free text whole would turn a read optimisation into a
 * write outage. Keying on a prefix removes the ceiling (a 10 000-char value
 * inserts fine) without changing the order: the prefix separates any two values
 * that differ inside it, and the full column breaks the remaining ties, so
 * `ORDER BY left(col, N), col` is the same order as `ORDER BY col` — verified
 * row-for-row on 200k rows. 500 characters stay under the limit even at 4 bytes
 * per character.
 */
export const TEXT_INDEX_PREFIX = 500;

/**
 * How a column must be indexed — decided by its PHYSICAL type, never guessed.
 *
 * Arrays (`multi_select`, multi `member`) take GIN: their operators are `@>`
 * and `&&`, which btree cannot serve at all. Text takes a prefix btree (above).
 * Everything else is fixed-width and takes the plain composite.
 */
const methodFor = (sqlType: string): IndexMethod => {
  if (sqlType.endsWith("[]")) return "gin_array";
  if (sqlType === "text") return "btree_prefix";
  // numeric / timestamptz / boolean / bigint / uuid — fixed width, no ceiling.
  return "btree";
};

/**
 * True when the column's index keys on a truncated prefix — the sort has to
 * lead with `left(col, TEXT_INDEX_PREFIX)` for the index to be usable.
 */
export const indexesTextPrefix = (sqlType: string): boolean =>
  methodFor(sqlType) === "btree_prefix";

/**
 * Deterministic index name, short enough for Postgres' 63-char identifier
 * limit. The table tail is already 32 hex chars, so the column is folded into a
 * hash rather than spelled out — two different columns can never collide, and
 * the same column always resolves to the same name (which is what makes
 * `IF NOT EXISTS` idempotent across calls).
 */
export const indexName = (collectionId: string, column: string): string => {
  const tail = collectionTableName(collectionId).slice("coll_".length);
  const digest = new Bun.CryptoHasher("sha256")
    .update(column)
    .digest("hex")
    .slice(0, 8);
  const name = `ix_${tail}_${digest}`;
  return name.length > MAX_PG_IDENT ? name.slice(0, MAX_PG_IDENT) : name;
};

/**
 * Rows below which an index is not worth building.
 *
 * A sequential scan of a few thousand rows costs single-digit milliseconds, and
 * most teams' types never grow past that. Indexing them all would pay write and
 * disk cost across thousands of tiny tables to save nothing measurable.
 */
export const INDEX_ROW_THRESHOLD = 20_000;

/**
 * Planner row estimate for an extension table — `reltuples`, not `count(*)`.
 *
 * This is the one place an estimate is the RIGHT answer: it is free (a catalog
 * lookup, no scan) and it only gates a "is this table big" decision, where
 * being off by a few percent changes nothing. A user-facing total still needs
 * an exact count.
 */
export const estimatedRowCount = async (
  collectionId: string,
): Promise<number> => {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT GREATEST(c.reltuples, 0)::bigint::int AS n
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'data' AND c.relname = ${collectionTableName(collectionId)}`,
  );
  return rows.rows[0]?.n ?? 0;
};

/**
 * Refresh the planner's statistics for one extension table.
 *
 * `reltuples` is maintained by VACUUM and autoanalyze, not by INSERT — so right
 * after a bulk load it still describes the table as it was BEFORE. Measured
 * here: 25 000 rows imported, and every index decision taken during the import
 * read an estimate of 55, concluded "too small to index", and skipped. The
 * autoanalyze that corrected it landed a minute later, with nothing left to
 * trigger a rebuild. That is precisely the path this feature exists for —
 * import a file, then build a page on it.
 *
 * Cheap by construction: `ANALYZE` samples rather than scans, and it is the
 * same refresh the QUERY PLANNER needs anyway — a page generated seconds after
 * an import would otherwise plan against statistics describing an empty table.
 */
export const analyzeCollectionTable = async (
  collectionId: string,
): Promise<void> => {
  await db.execute(
    sql.raw(`ANALYZE ${qualifiedCollectionTable(collectionId)}`),
  );
};

/**
 * Drop an index a previous `CONCURRENTLY` build left behind half-finished. A
 * failed concurrent build leaves an INVALID index that Postgres keeps
 * maintaining on writes but never reads — the worst of both. `IF NOT EXISTS`
 * would happily skip it forever, so it has to be cleared explicitly.
 */
const dropIfInvalid = async (name: string): Promise<void> => {
  const rows = await db.execute<{ invalid: boolean }>(
    sql`SELECT NOT i.indisvalid AS invalid
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = 'data' AND c.relname = ${name}`,
  );
  if (rows.rows[0]?.invalid) {
    await db.execute(
      sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS data."${name}"`),
    );
  }
};

/**
 * Ensure the index backing one column of one type. Idempotent and safe to call
 * concurrently: `IF NOT EXISTS` makes a redundant call a no-op.
 *
 * The column name is taken from `columnsForField`, never from caller text — the
 * same anti-DDL-injection boundary the rest of this layer relies on.
 */
export const ensureColumnIndex = async (input: {
  collectionId: string;
  column: string;
  sqlType: string;
}): Promise<void> => {
  const method = methodFor(input.sqlType);
  const table = qualifiedCollectionTable(input.collectionId);
  const name = indexName(input.collectionId, input.column);
  await dropIfInvalid(name);
  // The two tenancy columns lead on purpose: without an equality on them
  // Postgres cannot enter the index at all, so a sort on the third column falls
  // back to a full sort. Measured on 200k rows: 460 ms → 28 ms.
  const key =
    method === "btree_prefix"
      ? `left("${input.column}", ${TEXT_INDEX_PREFIX})`
      : `"${input.column}"`;
  const definition =
    method === "gin_array"
      ? `USING gin ("${input.column}")`
      : `("${SYS_COL.team}", "${SYS_COL.status}", ${key})`;
  await db.execute(
    sql.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON ${table} ${definition}`,
    ),
  );
};

/** A column an index is wanted on, resolved from a field definition. */
export interface IndexTarget {
  fieldId: string;
  column: string;
  sqlType: string;
}

/**
 * The columns of a type that deserve an index, by PHYSICAL type — no usage
 * signal involved.
 *
 * Why not learn from traffic: the schema is user-generated, the queries are
 * user-generated at runtime, and a typical path is "import a CSV, then build a
 * page on it" — nothing can be observed in time to help the first reader. And
 * the measurement says learning buys little: on single-row writes, ten indexes
 * cost 0.4% (35.39 ms → 35.52 ms per insert, lost in the round-trip). The one
 * place index count really bites is a single bulk statement, which is why
 * callers reconcile AFTER a load rather than before it.
 *
 * Skipped: `markdown` (long prose, filtered through the search vector, never
 * sorted) and computed fields, which have no column at all. `money` spreads
 * over `<key>_amount` + `<key>_currency`; only the amount is ever compared or
 * ordered, and `columnsForField` puts it first.
 *
 * Fields whose index the maintenance pass dropped as unused are excluded until
 * a query asks for that field again (see `indexDroppedAt`).
 */
export const indexTargetsForType = (
  fields: FieldDefinition[],
): IndexTarget[] => {
  const targets: IndexTarget[] = [];
  for (const field of fields) {
    if (!field.enabled || isVirtualField(field)) continue;
    if (field.type === "markdown") continue;
    if (field.indexDroppedAt !== null) continue;
    const [column] = columnsForField(field);
    if (!column) continue;
    targets.push({
      fieldId: field.id,
      column: column.name,
      sqlType: column.sqlType,
    });
  }
  return targets;
};

/** Auto-created index on one extension table, with Postgres' own usage counter. */
export interface AutoIndexUsage {
  name: string;
  /** Times the planner has actually read it since stats were last reset. */
  scans: number;
}

/**
 * Every index this module created for a type, with how often Postgres used it.
 *
 * `idx_scan` is the honest answer to "is this index earning its write cost" —
 * it is Postgres' own counter, so no application-side bookkeeping can drift
 * from it. Only indexes matching this module's naming are listed: the system
 * `(_team_id, _status)` index and anything hand-made stay out of reach.
 */
export const listAutoIndexUsage = async (
  collectionId: string,
): Promise<AutoIndexUsage[]> => {
  const tail = collectionTableName(collectionId).slice("coll_".length);
  const rows = await db.execute<{ name: string; scans: number }>(
    sql`SELECT indexrelname AS name, idx_scan::int AS scans
        FROM pg_stat_user_indexes
        WHERE schemaname = 'data' AND indexrelname LIKE ${`ix_${tail}_%`}`,
  );
  return rows.rows;
};

/** Drop one auto-created index. Refuses any name this module did not compose. */
export const dropAutoIndex = async (name: string): Promise<void> => {
  if (!/^ix_[0-9a-f]{32}_[0-9a-f]{8}$/.test(name)) {
    throw new Error(`Refusing to drop an index this module did not create`);
  }
  await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS data."${name}"`));
};
