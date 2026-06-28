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
]);

export const isVirtualField = (def: FieldDefinition): boolean =>
  VIRTUAL_TYPES.has(def.type);

/** Scalar field type → its single Postgres column type. */
const scalarSqlType = (type: FieldDefinitionType): string => {
  switch (type) {
    case "number":
    case "rating":
      return "numeric";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "boolean":
      return "boolean";
    case "multi_select":
      return "text[]";
    // text / markdown / phone / url / email / select → text.
    default:
      return "text";
  }
};

/**
 * The physical column(s) a field definition maps to. Most fields → one column;
 * `money` → two (`<key>_amount numeric`, `<key>_currency text`); `member` → one
 * (`uuid` single, `uuid[]` multiple). Virtual fields (relation/rollup) → none.
 */
export const columnsForField = (def: FieldDefinition): ColumnSpec[] => {
  if (isVirtualField(def)) return [];
  assertSafeKey(def.key, "field key");

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
