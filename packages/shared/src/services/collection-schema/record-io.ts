import { type SQL, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { hasTime } from "../../db/schema/field-types";
import { columnsForField, isVirtualField } from "./columns";
import {
  assertSafeKey,
  qualifiedCollectionTable,
  SYS_COL,
} from "./identifiers";

/**
 * Record I/O — the translation layer between a record's in-memory `data` object
 * (validated, keyed by field key) and the typed columns of its extension table
 * `data.coll_<collectionId>`. The rest of the codebase keeps speaking `data:
 * Record<string, unknown>`; only persistence changed (JSONB → typed columns).
 *
 *   - WRITE: `buildExtensionInsert` / `buildExtensionUpdate` compose
 *     parameterized SQL (values are bound params; identifiers are slug-guarded).
 *   - READ: `dataJsonbExpr` builds a `jsonb_build_object(...)` projection that
 *     reassembles the `data` object straight from the typed columns in ONE
 *     query, so retrieve/query stay a single round-trip.
 */

/** A registry record enriched with its reconstructed typed `data`. */
export type RecordWithData = {
  data: Record<string, unknown>;
};

const moneyAmount = (v: unknown): unknown =>
  typeof v === "object" && v !== null && "amount" in v
    ? (v as Record<string, unknown>).amount
    : null;
const moneyCurrency = (v: unknown): unknown =>
  typeof v === "object" && v !== null && "currencyCode" in v
    ? (v as Record<string, unknown>).currencyCode
    : null;

type ColumnValue = { name: string; sqlType: string; value: unknown };

/** The extension column(s) + bound value(s) a present field key writes to. */
const columnValues = (
  def: FieldDefinition,
  data: Record<string, unknown>,
): ColumnValue[] => {
  if (isVirtualField(def)) return [];
  // `unique_id` is filled by its sequence DEFAULT on insert and is read-only —
  // never write it (omitting the column lets the DEFAULT assign the next value).
  if (def.type === "unique_id") return [];
  // `formula` IS a physical column, but a `GENERATED ALWAYS AS … STORED` one:
  // Postgres refuses ANY value for it, `NULL` included ("cannot insert a
  // non-DEFAULT value into column …"). `patch` mode never named it (a formula
  // key is absent from record data), so only the `replace` builders — the bulk
  // INSERT and the full-replace UPDATE — ever hit that error, and they hit it
  // for the whole batch. Skipping it here is what keeps them writable.
  if (def.type === "formula") return [];
  assertSafeKey(def.key, "field key");
  const v = data[def.key] ?? null;
  if (def.type === "money") {
    return [
      { name: `${def.key}_amount`, sqlType: "numeric", value: moneyAmount(v) },
      { name: `${def.key}_currency`, sqlType: "text", value: moneyCurrency(v) },
    ];
  }
  const [c] = columnsForField(def);
  if (!c) return [];
  return [{ name: c.name, sqlType: c.sqlType, value: v }];
};

/** Bind one value with its column's cast. Arrays use an explicit `ARRAY[...]`. */
const valueParam = (sqlType: string, value: unknown): SQL => {
  if (value == null) return sql`NULL`;
  if (sqlType === "text[]" || sqlType === "uuid[]") {
    const elem = sqlType === "uuid[]" ? "uuid" : "text";
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) return sql`ARRAY[]::${sql.raw(elem)}[]`;
    return sql`ARRAY[${sql.join(
      items.map((i) => sql`${i}`),
      sql`, `,
    )}]::${sql.raw(elem)}[]`;
  }
  // jsonb: bind the JSON text so the driver doesn't guess the shape.
  if (sqlType === "jsonb") return sql`${JSON.stringify(value)}::jsonb`;
  return sql`${value}::${sql.raw(sqlType)}`;
};

/**
 * The columns+values to write. `patch` (default) writes only the field keys
 * present in `data`; `replace` writes EVERY scalar field (absent → NULL), for a
 * full-replace update.
 */
const collectColumnValues = (
  fields: FieldDefinition[],
  data: Record<string, unknown>,
  mode: "patch" | "replace",
): ColumnValue[] => {
  const out: ColumnValue[] = [];
  for (const def of fields) {
    if (isVirtualField(def)) continue;
    if (mode === "patch" && !(def.key in data)) continue;
    out.push(...columnValues(def, data));
  }
  return out;
};

/**
 * `INSERT` into the extension table: system columns (`id` = the registry id,
 * `_team_id`, `_label`, `_status`) plus a column per present scalar field.
 */
export const buildExtensionInsert = (input: {
  collectionId: string;
  recordId: string;
  teamId: string;
  label: string;
  status: string;
  fields: FieldDefinition[];
  data: Record<string, unknown>;
}): SQL => {
  const cols = [
    `"${SYS_COL.id}"`,
    `"${SYS_COL.team}"`,
    `"${SYS_COL.label}"`,
    `"${SYS_COL.status}"`,
  ];
  const vals: SQL[] = [
    sql`${input.recordId}::uuid`,
    sql`${input.teamId}::uuid`,
    sql`${input.label}::text`,
    sql`${input.status}::ontology_status`,
  ];
  for (const cv of collectColumnValues(input.fields, input.data, "patch")) {
    cols.push(`"${cv.name}"`);
    vals.push(valueParam(cv.sqlType, cv.value));
  }
  return sql`INSERT INTO ${sql.raw(qualifiedCollectionTable(input.collectionId))} (${sql.raw(
    cols.join(", "),
  )}) VALUES (${sql.join(vals, sql`, `)})`;
};

/**
 * Multi-row `INSERT` into the extension table — the batch counterpart of
 * `buildExtensionInsert`, used by `bulkCreateCollectionRecords` so N records of one
 * type land in ONE statement. Every tuple writes the SAME fixed column list
 * (system columns + every scalar field, absent → NULL), so the VALUES rows are
 * shape-aligned. Returns `null` for an empty batch.
 */
/**
 * Scalar columns one row of this type binds on the extension table.
 *
 * The batch builders below emit a fixed column template per row, so this IS the
 * per-row parameter count they will bind (plus the system columns the caller
 * adds). Bulk services feed it to `chunkSizeForParams` to size a chunk from the
 * type's real width instead of a fixed guess — a `money` field is two columns,
 * so the field count alone would under-report.
 */
export const extensionColumnCount = (fields: FieldDefinition[]): number =>
  collectColumnValues(fields, {}, "replace").length;

export const buildExtensionInsertBatch = (input: {
  collectionId: string;
  fields: FieldDefinition[];
  rows: {
    recordId: string;
    teamId: string;
    label: string;
    status: string;
    data: Record<string, unknown>;
  }[];
}): SQL | null => {
  if (input.rows.length === 0) return null;
  // Column template: every scalar column in field order (replace mode includes
  // absent fields too), so each row's `collectColumnValues(...,"replace")`
  // yields the identical column set in the identical order.
  const template = collectColumnValues(input.fields, {}, "replace");
  const cols = [
    `"${SYS_COL.id}"`,
    `"${SYS_COL.team}"`,
    `"${SYS_COL.label}"`,
    `"${SYS_COL.status}"`,
    ...template.map((c) => `"${c.name}"`),
  ];
  const tuples: SQL[] = input.rows.map((r) => {
    const rowVals = collectColumnValues(input.fields, r.data, "replace");
    const vals: SQL[] = [
      sql`${r.recordId}::uuid`,
      sql`${r.teamId}::uuid`,
      sql`${r.label}::text`,
      sql`${r.status}::ontology_status`,
      ...rowVals.map((cv) => valueParam(cv.sqlType, cv.value)),
    ];
    return sql`(${sql.join(vals, sql`, `)})`;
  });
  return sql`INSERT INTO ${sql.raw(qualifiedCollectionTable(input.collectionId))} (${sql.raw(
    cols.join(", "),
  )}) VALUES ${sql.join(tuples, sql`, `)}`;
};

/**
 * `UPDATE` the extension table: the columns of the present field keys, plus
 * `_label`/`_status` when given. Returns `null` if nothing to set.
 */
export const buildExtensionUpdate = (input: {
  collectionId: string;
  recordId: string;
  fields: FieldDefinition[];
  data: Record<string, unknown>;
  label?: string;
  status?: string;
  /** `replace` sets every scalar column (absent → NULL); `patch` only present keys. */
  mode?: "patch" | "replace";
}): SQL | null => {
  const sets: SQL[] = [];
  if (input.label !== undefined)
    sets.push(sql`${sql.raw(`"${SYS_COL.label}"`)} = ${input.label}::text`);
  if (input.status !== undefined)
    sets.push(
      sql`${sql.raw(`"${SYS_COL.status}"`)} = ${input.status}::ontology_status`,
    );
  for (const cv of collectColumnValues(
    input.fields,
    input.data,
    input.mode ?? "patch",
  )) {
    sets.push(
      sql`${sql.raw(`"${cv.name}"`)} = ${valueParam(cv.sqlType, cv.value)}`,
    );
  }
  if (sets.length === 0) return null;
  // A real update touches `updated_at` (created_at stays immutable).
  sets.push(sql`${sql.raw(`"${SYS_COL.updatedAt}"`)} = now()`);
  return sql`UPDATE ${sql.raw(qualifiedCollectionTable(input.collectionId))} SET ${sql.join(
    sets,
    sql`, `,
  )} WHERE "id" = ${input.recordId}::uuid`;
};

/**
 * Like {@link valueParam} but ALWAYS casts, including `NULL` → `NULL::<type>`.
 * Required inside a `VALUES (…)` list: the first row's bare `NULL` would be
 * inferred as `text` and clash with the target column type — explicit casts on
 * every value make each VALUES column unambiguous.
 */
const batchValueParam = (sqlType: string, value: unknown): SQL => {
  if (value == null) return sql`NULL::${sql.raw(sqlType)}`;
  return valueParam(sqlType, value);
};

/**
 * Multi-row full-replace `UPDATE` of the extension table via `… FROM (VALUES …)`
 * — the batch counterpart of `buildExtensionUpdate({ mode: "replace" })`, used
 * by `bulkUpdateCollectionRecords`. Every row sets `label` + every scalar column
 * (absent field → NULL), so one statement updates the whole chunk. Returns
 * `null` for an empty batch.
 */
export const buildExtensionUpdateBatch = (input: {
  collectionId: string;
  fields: FieldDefinition[];
  rows: { recordId: string; label: string; data: Record<string, unknown> }[];
}): SQL | null => {
  if (input.rows.length === 0) return null;
  const template = collectColumnValues(input.fields, {}, "replace");
  // VALUES columns: id, label, then every scalar column in field order.
  const valueCols = [
    `"${SYS_COL.id}"`,
    `"${SYS_COL.label}"`,
    ...template.map((c) => `"${c.name}"`),
  ];
  // SET only the data columns (id is the join key, not a target). The SET
  // TARGET must be a BARE column name — Postgres rejects an alias-qualified
  // target (`SET e."x" = …` is a syntax error); only the source side reads
  // from the VALUES alias (`v."x"`). The registry batch update follows the
  // same rule (`SET label = v.label`).
  const setCols = [`"${SYS_COL.label}"`, ...template.map((c) => `"${c.name}"`)];
  // Bump `updated_at` for every row in the batch (not a per-row VALUES column).
  const setClause = [
    ...setCols.map((c) => `${c} = v.${c}`),
    `"${SYS_COL.updatedAt}" = now()`,
  ].join(", ");
  const tuples: SQL[] = input.rows.map((r) => {
    const rowVals = collectColumnValues(input.fields, r.data, "replace");
    const vals: SQL[] = [
      sql`${r.recordId}::uuid`,
      sql`${r.label}::text`,
      ...rowVals.map((cv) => batchValueParam(cv.sqlType, cv.value)),
    ];
    return sql`(${sql.join(vals, sql`, `)})`;
  });
  return sql`UPDATE ${sql.raw(qualifiedCollectionTable(input.collectionId))} AS e
    SET ${sql.raw(setClause)}
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(${sql.raw(valueCols.join(", "))})
    WHERE e."id" = v."id"`;
};

/**
 * A `jsonb_build_object(...)` SQL fragment that reassembles a record's `data`
 * object from the typed columns of its extension table (aliased `alias`). Used
 * by retrieve/query to return `data` in a single query. Postgres renders typed
 * columns to JSON faithfully (numeric→number, date→"YYYY-MM-DD",
 * timestamptz→ISO, arrays→JSON array); `money` recomposes the `{amount,
 * currencyCode}` object. No user values, only slug-guarded keys → injection-safe.
 */
export const dataJsonbExpr = (
  fields: FieldDefinition[],
  alias = "e",
): string => {
  const pairs: string[] = [];
  for (const def of fields) {
    if (isVirtualField(def)) continue;
    assertSafeKey(def.key, "field key");
    if (def.type === "money") {
      pairs.push(
        `'${def.key}', CASE WHEN ${alias}."${def.key}_amount" IS NULL AND ${alias}."${def.key}_currency" IS NULL THEN NULL ELSE jsonb_build_object('amount', ${alias}."${def.key}_amount", 'currencyCode', ${alias}."${def.key}_currency") END`,
      );
    } else if (def.type === "location") {
      // The column holds a FK into `locations`; reconstruct the LocationValue
      // shape the API/frontend expects via a PK-lookup subquery (self-contained,
      // so every dataJsonbExpr caller stays a single query with no join plumbing).
      pairs.push(
        `'${def.key}', (SELECT jsonb_build_object('address', l.resolved_address, 'lat', ST_Y(l.geom), 'lng', ST_X(l.geom), 'mapboxId', l.mapbox_id, 'featureType', l.feature_type, 'bbox', l.bbox) FROM public.locations l WHERE l.id = ${alias}."${def.key}")`,
      );
    } else if (def.type === "date" && !hasTime(def.config)) {
      // The date family is a `timestamptz` column, but a time-less `date` reads
      // back as its UTC calendar day: the write is midnight UTC, so casting the
      // UTC wall-clock to `date` yields the intended day regardless of session
      // tz, and jsonb serializes a date as ISO "YYYY-MM-DD". Projection-only —
      // filters/sorts still hit the bare indexed column (see field-filter.ts).
      pairs.push(
        `'${def.key}', (${alias}."${def.key}" AT TIME ZONE 'UTC')::date`,
      );
    } else {
      pairs.push(`'${def.key}', ${alias}."${def.key}"`);
    }
  }
  return pairs.length > 0
    ? `jsonb_build_object(${pairs.join(", ")})`
    : `'{}'::jsonb`;
};

/**
 * Read the reconstructed `data` object for one record from its extension table.
 * Returns `{}` if the row is absent. Used by update (for the diff) and anywhere
 * a single record's typed values are needed without the registry columns.
 */
export const readRecordData = async (input: {
  collectionId: string;
  recordId: string;
  fields: FieldDefinition[];
  tx?: Executor;
}): Promise<Record<string, unknown>> => {
  const exec = input.tx ?? db;
  const expr = dataJsonbExpr(input.fields, "e");
  const res = await exec.execute(
    sql`SELECT ${sql.raw(expr)} AS data FROM ${sql.raw(
      qualifiedCollectionTable(input.collectionId),
    )} e WHERE e."id" = ${input.recordId}::uuid`,
  );
  const row = res.rows[0];
  if (!row || typeof row.data !== "object" || row.data === null) return {};
  return row.data as Record<string, unknown>;
};

/**
 * Batch variant of `readRecordData`: reconstruct `data` for many records of the
 * SAME type in one query, returned as a `Map<recordId, data>`. The N+1-free
 * primitive behind list reads (retrieve/query). The `data` map is only the
 * transport shape for the API/frontend; all querying happens on the real typed
 * columns, never on this JSON.
 */
export const readRecordDataBatch = async (input: {
  collectionId: string;
  recordIds: string[];
  fields: FieldDefinition[];
  tx?: Executor;
}): Promise<Map<string, Record<string, unknown>>> => {
  const map = new Map<string, Record<string, unknown>>();
  if (input.recordIds.length === 0) return map;
  const exec = input.tx ?? db;
  const expr = dataJsonbExpr(input.fields, "e");
  const res = await exec.execute(
    sql`SELECT e."id"::text AS id, ${sql.raw(expr)} AS data
        FROM ${sql.raw(qualifiedCollectionTable(input.collectionId))} e
        WHERE e."id" = ANY(${sql.param(input.recordIds)}::uuid[])`,
  );
  for (const row of res.rows) {
    map.set(
      String(row.id),
      typeof row.data === "object" && row.data !== null
        ? (row.data as Record<string, unknown>)
        : {},
    );
  }
  return map;
};
