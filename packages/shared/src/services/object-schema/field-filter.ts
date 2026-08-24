import { and, sql, type SQL } from "drizzle-orm";
import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";
import type { RecordFilter } from "../../schemas/ontology";

const SLUG = /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/;

/**
 * Postgres type each field's VALUE is cast to, so its COLUMN never has to be.
 *
 * Measured with EXPLAIN on a 200k-row table: `col::text = $1` falls back to a
 * Seq Scan on numeric / timestamptz / uuid / bigint columns — casting the column
 * hides it from its own index. Casting the literal instead yields `Index Cond`
 * on every type. A `text` column needs no cast on either side, which is why
 * `select` filters were the only ones already using an index.
 *
 * `member` is deliberately absent: its column is `uuid` OR `uuid[]` depending on
 * the field's config, which this builder cannot see, and casting the wrong way
 * is a hard SQL error — worse than a lost index. It compares as text until a
 * caller can pass the physical column type.
 */
const VALUE_CAST: Partial<Record<FieldDefinitionType, string>> = {
  number: "numeric",
  rating: "numeric",
  // `money` compares its `<key>_amount` column.
  money: "numeric",
  date: "timestamptz",
  created_time: "timestamptz",
  last_edited_time: "timestamptz",
  boolean: "boolean",
  unique_id: "bigint",
  location: "bigint",
  created_by: "uuid",
  last_edited_by: "uuid",
};

/** Field types stored in a plain `text` column — compared with no cast at all. */
const TEXT_TYPES = new Set<FieldDefinitionType>([
  "text",
  "markdown",
  "select",
  "url",
  "email",
  "phone",
]);

/**
 * Reject a value the cast would choke on. Without this `'abc'::numeric` raises
 * 22P02 mid-query, where the old `::text` comparison merely matched nothing.
 * Dropping the filter keeps that forgiving behaviour without the unindexable cast.
 */
const CAST_ACCEPTS: Record<string, (value: string) => boolean> = {
  numeric: (v) => v.trim() !== "" && Number.isFinite(Number(v)),
  bigint: (v) => /^-?\d+$/.test(v),
  timestamptz: (v) => !Number.isNaN(Date.parse(v)),
  uuid: (v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  boolean: (v) => /^(true|false|t|f|1|0)$/i.test(v),
};

/**
 * How one field's values must be written for the column to stay indexable.
 * `direct` — the column is already text. `cast` — cast the literal.
 * `text` — type unknown, fall back to casting the column (correct, unindexed).
 */
type Comparison =
  { kind: "direct" } | { kind: "cast"; cast: string } | { kind: "text" };

/**
 * What a `formula` column compares as, from the result type its compiler
 * inferred. It cannot go in `VALUE_CAST` because it is not fixed by the field
 * TYPE — it is fixed by the expression, which is why the config has to be read.
 *
 * Getting this wrong is not a lost index, it is a wrong answer: without the
 * cast the column falls back to a text comparison, where `'1500' > '500'` is
 * FALSE. Verified in Postgres before writing this.
 */
const formulaComparison = (config?: FieldDefinitionConfig): Comparison => {
  const result =
    config && "resultType" in config && typeof config.resultType === "string"
      ? config.resultType
      : "number";
  switch (result) {
    case "text":
      return { kind: "direct" };
    case "boolean":
      return { kind: "cast", cast: "boolean" };
    case "date":
      return { kind: "cast", cast: "timestamptz" };
    default:
      return { kind: "cast", cast: "double precision" };
  }
};

const comparisonFor = (
  fieldType?: FieldDefinitionType,
  config?: FieldDefinitionConfig,
): Comparison => {
  if (!fieldType) return { kind: "text" };
  if (fieldType === "formula") return formulaComparison(config);
  const cast = VALUE_CAST[fieldType];
  if (cast) return { kind: "cast", cast };
  return TEXT_TYPES.has(fieldType) ? { kind: "direct" } : { kind: "text" };
};

/** Left-hand side: the bare column, unless the type is unknown. */
const lhs = (col: SQL, comparison: Comparison): SQL =>
  comparison.kind === "text" ? sql`${col}::text` : col;

/** Right-hand side: the value, carrying the cast. Null when it can't be cast. */
const rhs = (
  value: string | number | boolean,
  comparison: Comparison,
): SQL | null => {
  const text = String(value);
  if (comparison.kind !== "cast") return sql`${text}`;
  const accepts = CAST_ACCEPTS[comparison.cast];
  if (accepts && !accepts(text)) return null;
  return sql`${text}::${sql.raw(comparison.cast)}`;
};

/** `ARRAY[…]::<type>[]` for `in`, skipping values the cast would reject. */
const rhsArray = (
  values: readonly (string | number | boolean)[],
  comparison: Comparison,
): SQL | null => {
  const cast = comparison.kind === "cast" ? comparison.cast : "text";
  const accepts = CAST_ACCEPTS[cast];
  const kept = values
    .map((value) => String(value))
    .filter((value) => !accepts || accepts(value));
  if (kept.length === 0) return null;
  return sql`ARRAY[${sql.join(
    kept.map((value) => sql`${value}`),
    sql`, `,
  )}]::${sql.raw(cast)}[]`;
};

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
  // A `formula` compares as whatever its expression evaluates to, which only
  // its config knows. Unused by every other field type.
  config?: FieldDefinitionConfig,
): SQL | null => {
  if (!columnOverride && !SLUG.test(f.key)) return null;
  const isMoney = fieldType === "money";
  const isMulti = fieldType === "multi_select";
  const colName = isMoney ? `${f.key}_amount` : f.key;
  const col = columnOverride ?? sql.raw(`e."${colName}"`);
  const comparison = comparisonFor(fieldType, config);
  const left = lhs(col, comparison);

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
      // `object` is the `{ start, end }` range — only valid for `between`.
      if (v === undefined || Array.isArray(v) || typeof v === "object")
        return null;
      const value = rhs(v, comparison);
      if (!value) return null;
      return sql`${left} = ${value}`;
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
      const value = rhs(v, comparison);
      if (!value) return null;
      return sql`${left} IS DISTINCT FROM ${value}`;
    }
    case "contains": {
      const v = f.value;
      if (typeof v !== "string") return null;
      if (isMulti)
        return sql`${sql.raw(`e."${f.key}"`)} @> ARRAY[${v}]::text[]`;
      // A text column stays uncast; any other type has to become text to be
      // matched at all.
      //
      // Neither form is indexable today, and that is a real limit rather than
      // an oversight: `indexTargetsForType` gives a text column a btree on
      // `left(col, 500)`, which a leading wildcard cannot enter, and the trigram
      // index that COULD serve it was measured at +49% on a 200 000-row import
      // (25.0 s against 16.8 s) — too much to pay on every write of every type
      // for a filter most types never use. So a `contains` filter scans the
      // type. The registry's own search does not: `object_records` already
      // carries a trigram index on `normalized_label` (see `retrieve.ts`).
      const target = comparison.kind === "direct" ? col : sql`${col}::text`;
      return sql`${target} ILIKE ${`%${v}%`}`;
    }
    case "in": {
      const v = f.value;
      if (!Array.isArray(v) || v.length === 0) return null;
      // On a `text[]` column, "in" means "shares at least one value" — comparing
      // the whole array as text would only ever match one exact combination.
      if (isMulti) {
        const values = rhsArray(v, { kind: "direct" });
        if (!values) return null;
        return sql`${sql.raw(`e."${f.key}"`)} && ${values}`;
      }
      // A JS array bound as ONE placeholder becomes `ANY(($1, $2, …))` — a row
      // constructor Postgres rejects, so every `in` filter was a 500. Build the
      // array literal explicitly instead, carrying the column's type.
      const values = rhsArray(v, comparison);
      if (!values) return null;
      return sql`${left} = ANY(${values})`;
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
      // The column stays bare here whatever the type: an unknown type keeps the
      // old inferred comparison (`col > $1`) rather than `col::text > $1`, which
      // would silently order numbers lexicographically.
      const value = rhs(v, comparison);
      if (!value) return null;
      return sql`${col} ${opSql} ${value}`;
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
      const start = v.start === null ? null : rhs(v.start, comparison);
      const end = v.end === null ? null : rhs(v.end, comparison);
      if (start) bounds.push(sql`${col} >= ${start}`);
      if (end) bounds.push(sql`${col} <= ${end}`);
      if (bounds.length === 0) return null;
      return and(...bounds) ?? sql`TRUE`;
    }
    default:
      return null;
  }
};
