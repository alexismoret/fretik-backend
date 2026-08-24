import type { FieldDefinition } from "../../db/schema";
import type { FieldDefinitionType } from "../../db/schema/field-types";
import { isMultiMember } from "../../db/schema/field-types";
import { assertSafeKey } from "./identifiers";

/**
 * Field-type → physical column mapping — the heart of the DDL engine. Replaces
 * the old guarded-cast machinery: values are TYPED at write, so reads need no
 * cast and bad values are rejected by Postgres, not silently stored.
 *
 * `relation` and `rollup` produce NO column — relations live in the `links`
 * graph and rollups are computed in the read view, so neither ever triggers an
 * `ALTER TABLE` when it changes.
 */

/** A single physical column to create on the extension table. */
export type ColumnSpec = {
  /** Quote-free column name (already slug-safe). */
  name: string;
  /** Postgres type, e.g. `text`, `numeric`, `timestamptz`, `text[]`, `uuid`. */
  sqlType: string;
};

/** Field types that are graph-derived / computed → never a physical column. */
const VIRTUAL_TYPES: ReadonlySet<FieldDefinitionType> = new Set([
  "relation",
  "rollup",
  // System properties — read-only projections of the registry's own columns.
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
]);

export const isVirtualField = (def: FieldDefinition): boolean =>
  VIRTUAL_TYPES.has(def.type);

/** Scalar field type → its single Postgres column type. */
const scalarSqlType = (type: FieldDefinitionType): string => {
  switch (type) {
    case "number":
    case "rating":
      return "numeric";
    // The date family is always an instant (`config.hasTime` only toggles
    // display/coercion) so a time-less value is midnight UTC — one column type,
    // no DDL when the toggle flips.
    case "date":
      return "timestamptz";
    case "boolean":
      return "boolean";
    case "multi_select":
      return "text[]";
    // Auto-increment counter — the DDL engine attaches a per-field sequence and
    // a `DEFAULT nextval(...)` (see table.ts); the write path never sets it.
    case "unique_id":
      return "bigint";
    // Geocoded place — a FK (bigint) into the per-team `locations` table. The
    // LocationValue is reconstructed on read via a LEFT JOIN (see record-io).
    case "location":
      return "bigint";
    // text / markdown / phone / url / email / select → text.
    default:
      return "text";
  }
};

/**
 * Physical column type of a `formula` field, from the result type its compiler
 * inferred.
 *
 * `number` is `double precision`, NOT `numeric`, and that choice is load-bearing:
 * the driver hands `numeric` back as a STRING, which is exactly how `rollup`
 * ends up returning `"0"` for a count — a difference nobody notices until a
 * comparison or a sum silently misbehaves in a page. A formula must arrive as a
 * JS number.
 */
const formulaSqlType = (config: FieldDefinition["config"]): string => {
  const result =
    "resultType" in config && typeof config.resultType === "string"
      ? config.resultType
      : "number";
  switch (result) {
    case "text":
      return "text";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamptz";
    default:
      return "double precision";
  }
};

/**
 * The physical column(s) a field definition maps to. Most fields → one column;
 * `money` → two (`<key>_amount numeric`, `<key>_currency text`); `member` → one
 * (`uuid` single, `uuid[]` multiple). Virtual fields (relation/rollup) → none.
 *
 * A `formula` DOES get a column — a `GENERATED … STORED` one. The generating
 * expression is not composed here (it needs the type's other fields, which this
 * function does not have); `table.ts` adds it at DDL time. Everything else —
 * reconciling, dropping, renaming, projecting, sorting — then treats a formula
 * as the ordinary column it is.
 */
export const columnsForField = (def: FieldDefinition): ColumnSpec[] => {
  if (isVirtualField(def)) return [];
  assertSafeKey(def.key, "field key");

  if (def.type === "formula") {
    return [{ name: def.key, sqlType: formulaSqlType(def.config) }];
  }
  if (def.type === "money") {
    return [
      { name: `${def.key}_amount`, sqlType: "numeric" },
      { name: `${def.key}_currency`, sqlType: "text" },
    ];
  }
  if (def.type === "member") {
    return [
      { name: def.key, sqlType: isMultiMember(def.config) ? "uuid[]" : "uuid" },
    ];
  }
  return [{ name: def.key, sqlType: scalarSqlType(def.type) }];
};
