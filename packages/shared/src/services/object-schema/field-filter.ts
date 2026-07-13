import { and, sql, type SQL } from "drizzle-orm";
import type { FieldDefinitionType } from "../../db/schema";
import type { RecordFilter } from "../../schemas/ontology";

const SLUG = /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/;

/**
 * Translate one field filter into a comparison predicate over a type's
 * extension table, referencing its columns through the alias `e` (e.g.
 * `e."amount"`). Callers wrap the returned predicate in their own `EXISTS`
 * correlated to the row they're filtering — `object_records.id` for the records
 * list, `documents.id → mirror record` for the drive — with the extension table
 * aliased `e` so the column references resolve. This is the single source of
 * truth for field-filter SQL; both the records list and the drive call it.
 *
 * `money` compares its `<key>_amount` column; `multi_select` membership uses the
 * base array column. Keys are slug-guarded; values parameterized. Returns null
 * for an invalid key or an unsupported value shape.
 */
export const buildFieldFilterPredicate = (
  f: RecordFilter,
  fieldType?: FieldDefinitionType,
  // Column the predicate compares against. Defaults to the field's extension
  // column (`e."<key>"`). System-property fields pass the `object_records`
  // registry column they project (created_at / updated_at / …), so the same
  // per-operator SQL serves both without an extension EXISTS.
  columnOverride?: SQL,
): SQL | null => {
  if (!columnOverride && !SLUG.test(f.key)) return null;
  const isMoney = fieldType === "money";
  const isMulti = fieldType === "multi_select";
  const colName = isMoney ? `${f.key}_amount` : f.key;
  const col = columnOverride ?? sql.raw(`e."${colName}"`);

  switch (f.op) {
    case "is_empty":
      return sql`${col} IS NULL`;
    case "is_not_empty":
      return sql`${col} IS NOT NULL`;
    case "is_true":
      return sql`${col} = true`;
    case "is_false":
      return sql`${col} = false`;
    case "eq": {
      const v = f.value;
      if (typeof v === "boolean") return sql`${col} = ${v}`;
      // `object` is the `{ start, end }` range — only valid for `between`.
      if (v === undefined || Array.isArray(v) || typeof v === "object")
        return null;
      if (isMoney && typeof v === "number") return sql`${col} = ${v}`;
      return sql`${col}::text = ${String(v)}`;
    }
    case "neq": {
      const v = f.value;
      if (
        v === undefined ||
        Array.isArray(v) ||
        typeof v === "boolean" ||
        typeof v === "object"
      )
        return null;
      if (isMoney && typeof v === "number")
        return sql`${col} IS DISTINCT FROM ${v}`;
      return sql`${col}::text IS DISTINCT FROM ${String(v)}`;
    }
    case "contains": {
      const v = f.value;
      if (typeof v !== "string") return null;
      if (isMulti)
        return sql`${sql.raw(`e."${f.key}"`)} @> ARRAY[${v}]::text[]`;
      return sql`${col}::text ILIKE ${`%${v}%`}`;
    }
    case "in": {
      const v = f.value;
      if (!Array.isArray(v) || v.length === 0) return null;
      return sql`${col}::text = ANY(${v})`;
    }
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const v = f.value;
      if (
        v === undefined ||
        Array.isArray(v) ||
        typeof v === "boolean" ||
        typeof v === "object"
      )
        return null;
      const opSql =
        f.op === "gt"
          ? sql`>`
          : f.op === "lt"
            ? sql`<`
            : f.op === "gte"
              ? sql`>=`
              : sql`<=`;
      return sql`${col} ${opSql} ${v}`;
    }
    // Date / datetime range. Either bound may be null → open interval; both
    // null → no predicate.
    case "between": {
      const v = f.value;
      if (
        typeof v !== "object" ||
        v === null ||
        Array.isArray(v) ||
        !("start" in v) ||
        !("end" in v)
      )
        return null;
      const bounds: SQL[] = [];
      if (v.start) bounds.push(sql`${col} >= ${v.start}`);
      if (v.end) bounds.push(sql`${col} <= ${v.end}`);
      if (bounds.length === 0) return null;
      return and(...bounds) ?? sql`TRUE`;
    }
    default:
      return null;
  }
};
