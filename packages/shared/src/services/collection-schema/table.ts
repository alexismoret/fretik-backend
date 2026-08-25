// oxlint-disable no-await-in-loop
import { eq, sql } from "drizzle-orm";
import db, { type Executor, type Transaction } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { columnsForField } from "./columns";
import { compileFormula } from "./formula/compile";
import {
  assertSafeUuid,
  collectionTableName,
  DATA_SCHEMA,
  qualifiedCollectionTable,
  SQL_TOOL_ROLE,
  SYS_COL,
  SYSTEM_COLUMN_NAMES,
  uniqueIdSequenceName,
} from "./identifiers";

/**
 * Physical-table lifecycle for collections — the DDL engine. Driven by the
 * catalog (`collections` + `field_definitions`), it keeps one real, strongly
 * typed table `data.coll_<typeId-hex>` per collection in sync with that type's
 * scalar fields, and arms its row-level security.
 *
 * Each extension table holds (system columns are underscore-prefixed so they can
 * never collide with a field's column — field keys must start with a letter):
 *   - `id`        — PK + FK to the `collection_records` registry. NOT auto-generated;
 *                   it equals the registry id the write service already minted.
 *   - `_team_id`  — owning team, denormalized so the RLS predicate is an indexed
 *                   equality with no join.
 *   - `_label` / `_status` — denormalized so the chatbot can filter/sort directly
 *                   on the real table without joining the registry.
 *   - one typed column per scalar field, named by the field key (a field keyed
 *     `status` gets a bare `status` column, distinct from `_status`).
 *
 * There is NO per-type view: the chatbot's read tool queries these tables (and
 * the registry) directly. Safety is row-level security: the SQL read role
 * (`fretik_sql_tool`) is SELECT-only and every table is armed at creation with
 * `_team_id = fretik_team() OR fretik_record_visible(id)` (the helper folds the
 * inherit-aware type grant and the record share). The `fretik_*` helpers live in the foundation
 * migration. The dedicated `data` schema is created once by migration (global to
 * the SaaS), never at runtime. DDL composes raw identifiers, every one
 * slug/UUID-guarded upstream (`identifiers.ts`) — the anti-injection boundary.
 */

const ddl = async (exec: Executor, stmt: string): Promise<void> => {
  await exec.execute(sql.raw(stmt));
};

/**
 * Arm row-level security on a freshly-created (or re-synced) extension table:
 * enable RLS, (re)create the read policy for the SQL tool role, grant SELECT.
 * Idempotent — `DROP POLICY IF EXISTS` then `CREATE`. The policy text is
 * type-independent (`fretik_record_visible(id)` resolves the type + inherit flag
 * from the registry), so it is identical across every extension table.
 */
const armTableSecurity = async (
  exec: Executor,
  collectionId: string,
): Promise<void> => {
  const table = qualifiedCollectionTable(collectionId);
  await ddl(exec, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await ddl(exec, `DROP POLICY IF EXISTS sql_tool_read ON ${table}`);
  await ddl(
    exec,
    `CREATE POLICY sql_tool_read ON ${table} FOR SELECT TO ${SQL_TOOL_ROLE}
       USING (
         ${SYS_COL.team} = fretik_team()
         OR fretik_record_visible(${SYS_COL.id})
       )`,
  );
  await ddl(exec, `GRANT SELECT ON ${table} TO ${SQL_TOOL_ROLE}`);
};

/**
 * Create the extension table for a type if absent (with system columns + a
 * column per scalar field) and arm its security. Idempotent. Pass the type's
 * ENABLED field definitions; adding fields later is `addFieldColumns`.
 */
export const ensureCollectionTable = async (input: {
  collectionId: string;
  fields: FieldDefinition[];
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  assertSafeUuid(input.collectionId, "collection id");
  const table = qualifiedCollectionTable(input.collectionId);
  const tableTail = collectionTableName(input.collectionId).slice(-12);

  // Create with system columns only; field columns are then ADDed idempotently
  // (`ADD COLUMN IF NOT EXISTS`), so this both creates a fresh table AND fills in
  // missing FIELD columns on an existing one.
  await ddl(
    exec,
    `CREATE TABLE IF NOT EXISTS ${table} (
       ${SYS_COL.id} uuid PRIMARY KEY REFERENCES collection_records(id) ON DELETE CASCADE,
       ${SYS_COL.team} uuid NOT NULL,
       ${SYS_COL.label} text NOT NULL DEFAULT '',
       ${SYS_COL.status} ontology_status NOT NULL DEFAULT 'confirmed',
       ${SYS_COL.createdAt} timestamptz NOT NULL DEFAULT now(),
       ${SYS_COL.updatedAt} timestamptz NOT NULL DEFAULT now()
     )`,
  );
  // Formula columns go LAST: a generated column's expression names the columns
  // it reads, so adding one before them fails with a bare "column does not
  // exist". Catalog order is arbitrary — a formula created before the field it
  // uses is perfectly ordinary — so the ordering has to be imposed here.
  const ordered = [
    ...input.fields.filter((f) => f.type !== "formula"),
    ...input.fields.filter((f) => f.type === "formula"),
  ];
  for (const def of ordered) {
    await addFieldColumns({
      collectionId: input.collectionId,
      field: def,
      siblings: input.fields,
      tx: input.tx,
    });
  }
  await ddl(
    exec,
    `CREATE INDEX IF NOT EXISTS ix_${tableTail}_team ON ${table} (${SYS_COL.team}, ${SYS_COL.status})`,
  );
  await armTableSecurity(exec, input.collectionId);
};

/**
 * Reconcile a collection's extension table to its CURRENT field set: create
 * the table if missing, ADD columns for new fields, and DROP columns whose field
 * was deleted. The desired column set is the UNION of every field definition for
 * the type ACROSS ALL TEAMS — a single physical table backs a type, and an
 * org/system type's teams can diverge, so reconciling for one team must never
 * drop another team's column. Disabled fields keep their column (data hidden,
 * not lost); only a truly removed field def drops its column. The single
 * idempotent hook after any field change — handles create / delete uniformly
 * (retype/rename go through the explicit `changeFieldColumns`/`renameFieldColumns`
 * because they keep the column NAME). Reads field defs DIRECTLY (post-change
 * truth, not the Redis cache).
 */
export const reconcileCollectionTable = async (input: {
  collectionId: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  assertSafeUuid(input.collectionId, "collection id");

  const fields = await exec
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.collectionId, input.collectionId));
  await ensureCollectionTable({
    collectionId: input.collectionId,
    fields,
    tx: input.tx,
  });

  const desired = new Set<string>();
  for (const def of fields)
    for (const c of columnsForField(def)) desired.add(c.name);

  const existing = await exec.execute(
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${DATA_SCHEMA}
          AND table_name = ${collectionTableName(input.collectionId)}`,
  );
  const table = qualifiedCollectionTable(input.collectionId);
  for (const row of existing.rows) {
    const name = String(row.column_name);
    if (SYSTEM_COLUMN_NAMES.has(name) || desired.has(name)) continue;
    await ddl(exec, `ALTER TABLE ${table} DROP COLUMN IF EXISTS "${name}"`);
  }
};

/**
 * The `GENERATED ALWAYS AS (…) STORED` tail of a formula field's column.
 *
 * The expression is COMPILED here, never stored: `config.expression` holds the
 * author's formula, and the SQL is derived from it against the type's current
 * fields every time the column is built. That is what keeps a formula honest
 * when the fields under it move — there is no second copy of the SQL to go
 * stale — and it keeps `compileFormula` the only path from text to SQL.
 */
const formulaTail = (
  field: FieldDefinition,
  siblings: FieldDefinition[],
): string => {
  const source =
    "expression" in field.config && typeof field.config.expression === "string"
      ? field.config.expression
      : "";
  // Compiles, or throws a FormulaError the caller surfaces. A formula field
  // whose expression no longer resolves must NOT silently become a plain
  // column: the values it held would stop updating with nothing to show for it.
  const compiled = compileFormula({ source, fields: siblings });
  return ` GENERATED ALWAYS AS (${compiled.sql}) STORED`;
};

/** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for a newly-added field. No-op for virtual fields. */
export const addFieldColumns = async (input: {
  collectionId: string;
  field: FieldDefinition;
  /**
   * The type's other fields — required to build a `formula` column, whose
   * expression names them. Unused by every other field type.
   */
  siblings?: FieldDefinition[];
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedCollectionTable(input.collectionId);
  // A formula is a generated column: it carries its expression, and the DB
  // itself then refuses any write to it — a stronger guarantee than the
  // write-path skip lists, and one the SQL tool cannot get around either.
  if (input.field.type === "formula") {
    const [c] = columnsForField(input.field);
    if (!c) return;
    const tail = formulaTail(input.field, input.siblings ?? [input.field]);
    await ddl(
      exec,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${c.name}" ${c.sqlType}${tail}`,
    );
    return;
  }
  // `unique_id`: a dedicated sequence fills the column (Notion "Unique ID" — a
  // sequential per-type counter). Adding a NOT NULL column with a volatile
  // default backfills every existing row with a distinct value; `OWNED BY` ties
  // the sequence's lifetime to the column, so a drop/retype removes it too.
  if (input.field.type === "unique_id") {
    const [c] = columnsForField(input.field);
    if (!c) return;
    const seq = uniqueIdSequenceName(input.field.id);
    await ddl(exec, `CREATE SEQUENCE IF NOT EXISTS ${seq}`);
    await ddl(
      exec,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${c.name}" bigint NOT NULL DEFAULT nextval('${seq}')`,
    );
    await ddl(exec, `ALTER SEQUENCE ${seq} OWNED BY ${table}."${c.name}"`);
    return;
  }
  for (const c of columnsForField(input.field)) {
    await ddl(
      exec,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${c.name}" ${c.sqlType}`,
    );
  }
};

/** `ALTER TABLE … DROP COLUMN IF EXISTS` for a removed field. No-op for virtual fields. */
export const dropFieldColumns = async (input: {
  collectionId: string;
  field: FieldDefinition;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedCollectionTable(input.collectionId);
  for (const c of columnsForField(input.field)) {
    await ddl(exec, `ALTER TABLE ${table} DROP COLUMN IF EXISTS "${c.name}"`);
  }
};

/**
 * Apply a field TYPE change. The physical shape can change (money↔scalar,
 * member single↔multi, multi_select↔scalar), so this drops the old column(s)
 * and adds the new — i.e. the field's stored values are RESET on a type change.
 * Data-preserving moves are the job of the higher-level migration tools (P2).
 */
export const changeFieldColumns = async (input: {
  collectionId: string;
  oldField: FieldDefinition;
  newField: FieldDefinition;
  siblings?: FieldDefinition[];
  tx?: Transaction;
}): Promise<void> => {
  await dropFieldColumns({
    collectionId: input.collectionId,
    field: input.oldField,
    tx: input.tx,
  });
  await addFieldColumns({
    collectionId: input.collectionId,
    field: input.newField,
    siblings: input.siblings,
    tx: input.tx,
  });
};

/**
 * Rebuild a formula's column after its EXPRESSION changed — drop, then re-add
 * with the newly compiled clause.
 *
 * It needs its own entry point because the idempotent path cannot see the
 * change: `reconcileCollectionTable` compares column NAMES, and `ADD COLUMN IF NOT
 * EXISTS` finds the column already there and does nothing. Editing a formula
 * would appear to succeed while every row kept the old value — the worst
 * available outcome, since the numbers stay plausible.
 *
 * Dropping recomputes every row on the way back in, which is the point: a stored
 * generated column has no other way to be brought up to date.
 */
export const rebuildFormulaColumn = async (input: {
  collectionId: string;
  field: FieldDefinition;
  siblings: FieldDefinition[];
  tx?: Transaction;
}): Promise<void> => {
  await dropFieldColumns({
    collectionId: input.collectionId,
    field: input.field,
    tx: input.tx,
  });
  await addFieldColumns({
    collectionId: input.collectionId,
    field: input.field,
    siblings: input.siblings,
    tx: input.tx,
  });
};

/**
 * Rename a field's column(s) when its key changes — `ALTER TABLE RENAME COLUMN`,
 * which PRESERVES the data (unlike a drop+add). `money` renames both suffixed
 * columns. No-op for virtual fields. The new key must be slug-safe (the caller's
 * field-def write already validated it; re-checked via `columnsForField`).
 */
export const renameFieldColumns = async (input: {
  collectionId: string;
  oldField: FieldDefinition;
  newKey: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedCollectionTable(input.collectionId);
  const renamed: FieldDefinition = { ...input.oldField, key: input.newKey };
  const oldCols = columnsForField(input.oldField);
  const newCols = columnsForField(renamed);
  for (let i = 0; i < oldCols.length; i++) {
    const from = oldCols[i]?.name;
    const to = newCols[i]?.name;
    if (!from || !to || from === to) continue;
    await ddl(exec, `ALTER TABLE ${table} RENAME COLUMN "${from}" TO "${to}"`);
  }
};

/** Drop the extension table on type deletion. */
export const dropCollectionTable = async (input: {
  collectionId: string;
  tx?: Transaction;
}): Promise<void> => {
  await ddl(
    input.tx ?? db,
    `DROP TABLE IF EXISTS ${qualifiedCollectionTable(input.collectionId)} CASCADE`,
  );
};

/** Bare physical-table name (`coll_<hex>`), exported for diagnostics/backfill. */
export { collectionTableName };
