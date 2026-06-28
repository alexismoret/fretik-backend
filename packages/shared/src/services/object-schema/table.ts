// oxlint-disable no-await-in-loop
import { eq, sql } from "drizzle-orm";
import db, { type Executor, type Transaction } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { columnsForField } from "./columns";
import {
  assertSafeUuid,
  DATA_SCHEMA,
  objectTableName,
  qualifiedObjectTable,
  SQL_TOOL_ROLE,
  SYS_COL,
  SYSTEM_COLUMN_NAMES,
} from "./identifiers";

/** Structural columns every extension table owns (never field-derived). */
const SYSTEM_COLUMNS = SYSTEM_COLUMN_NAMES;

/**
 * Physical-table lifecycle for object types — the DDL engine. Driven by the
 * catalog (`object_types` + `field_definitions`), it keeps one real, strongly
 * typed table `data.obj_<typeId-hex>` per object type in sync with that type's
 * scalar fields, and arms its row-level security.
 *
 * Each extension table holds (system columns are underscore-prefixed so they can
 * never collide with a field's column — field keys must start with a letter):
 *   - `id`        — PK + FK to the `object_records` registry. NOT auto-generated;
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
 * `_team_id = fretik_team() OR fretik_type_granted(<typeId>) OR
 * fretik_record_shared(id)`. The `fretik_*` helpers live in the foundation
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
 * Idempotent — `DROP POLICY IF EXISTS` then `CREATE`. The object-type id is a
 * constant for the whole table, so `fretik_type_granted(<id>)` is constant-folded
 * (no per-row lookup).
 */
const armTableSecurity = async (
  exec: Executor,
  objectTypeId: string,
): Promise<void> => {
  const table = qualifiedObjectTable(objectTypeId);
  await ddl(exec, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await ddl(exec, `DROP POLICY IF EXISTS sql_tool_read ON ${table}`);
  await ddl(
    exec,
    `CREATE POLICY sql_tool_read ON ${table} FOR SELECT TO ${SQL_TOOL_ROLE}
       USING (
         ${SYS_COL.team} = fretik_team()
         OR fretik_type_granted('${objectTypeId}'::uuid)
         OR fretik_record_shared(${SYS_COL.id})
       )`,
  );
  await ddl(exec, `GRANT SELECT ON ${table} TO ${SQL_TOOL_ROLE}`);
};

/**
 * Create the extension table for a type if absent (with system columns + a
 * column per scalar field) and arm its security. Idempotent. Pass the type's
 * ENABLED field definitions; adding fields later is `addFieldColumns`.
 */
export const ensureObjectTable = async (input: {
  objectTypeId: string;
  fields: FieldDefinition[];
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  assertSafeUuid(input.objectTypeId, "object type id");
  const table = qualifiedObjectTable(input.objectTypeId);
  const tableTail = objectTableName(input.objectTypeId).slice(-12);

  // Create with system columns only; field columns are then ADDed idempotently
  // (`ADD COLUMN IF NOT EXISTS`), so this both creates a fresh table AND fills in
  // missing FIELD columns on an existing one.
  await ddl(
    exec,
    `CREATE TABLE IF NOT EXISTS ${table} (
       ${SYS_COL.id} uuid PRIMARY KEY REFERENCES object_records(id) ON DELETE CASCADE,
       ${SYS_COL.team} uuid NOT NULL,
       ${SYS_COL.label} text NOT NULL DEFAULT '',
       ${SYS_COL.status} ontology_status NOT NULL DEFAULT 'confirmed',
       ${SYS_COL.createdAt} timestamptz NOT NULL DEFAULT now(),
       ${SYS_COL.updatedAt} timestamptz NOT NULL DEFAULT now()
     )`,
  );
  for (const def of input.fields) {
    await addFieldColumns({
      objectTypeId: input.objectTypeId,
      field: def,
      tx: input.tx,
    });
  }
  await ddl(
    exec,
    `CREATE INDEX IF NOT EXISTS ix_${tableTail}_team ON ${table} (${SYS_COL.team}, ${SYS_COL.status})`,
  );
  await armTableSecurity(exec, input.objectTypeId);
};

/**
 * Reconcile an object type's extension table to its CURRENT field set: create
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
export const reconcileObjectTable = async (input: {
  objectTypeId: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  assertSafeUuid(input.objectTypeId, "object type id");

  const fields = await exec
    .select()
    .from(fieldDefinitions)
    .where(eq(fieldDefinitions.objectTypeId, input.objectTypeId));
  await ensureObjectTable({
    objectTypeId: input.objectTypeId,
    fields,
    tx: input.tx,
  });

  const desired = new Set<string>();
  for (const def of fields)
    for (const c of columnsForField(def)) desired.add(c.name);

  const existing = await exec.execute(
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${DATA_SCHEMA}
          AND table_name = ${objectTableName(input.objectTypeId)}`,
  );
  const table = qualifiedObjectTable(input.objectTypeId);
  for (const row of existing.rows) {
    const name = String(row.column_name);
    if (SYSTEM_COLUMNS.has(name) || desired.has(name)) continue;
    await ddl(exec, `ALTER TABLE ${table} DROP COLUMN IF EXISTS "${name}"`);
  }
};

/** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for a newly-added field. No-op for virtual fields. */
export const addFieldColumns = async (input: {
  objectTypeId: string;
  field: FieldDefinition;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedObjectTable(input.objectTypeId);
  for (const c of columnsForField(input.field)) {
    await ddl(
      exec,
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${c.name}" ${c.sqlType}`,
    );
  }
};

/** `ALTER TABLE … DROP COLUMN IF EXISTS` for a removed field. No-op for virtual fields. */
export const dropFieldColumns = async (input: {
  objectTypeId: string;
  field: FieldDefinition;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedObjectTable(input.objectTypeId);
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
  objectTypeId: string;
  oldField: FieldDefinition;
  newField: FieldDefinition;
  tx?: Transaction;
}): Promise<void> => {
  await dropFieldColumns({
    objectTypeId: input.objectTypeId,
    field: input.oldField,
    tx: input.tx,
  });
  await addFieldColumns({
    objectTypeId: input.objectTypeId,
    field: input.newField,
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
  objectTypeId: string;
  oldField: FieldDefinition;
  newKey: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const table = qualifiedObjectTable(input.objectTypeId);
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
export const dropObjectTable = async (input: {
  objectTypeId: string;
  tx?: Transaction;
}): Promise<void> => {
  await ddl(
    input.tx ?? db,
    `DROP TABLE IF EXISTS ${qualifiedObjectTable(input.objectTypeId)} CASCADE`,
  );
};

/** Bare physical-table name (`obj_<hex>`), exported for diagnostics/backfill. */
export { objectTableName };
