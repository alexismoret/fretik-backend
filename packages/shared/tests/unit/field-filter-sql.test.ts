import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { FieldDefinitionType } from "../../src/db/schema";
import type { RecordFilter } from "../../src/schemas/ontology";
import { buildFieldFilterPredicate } from "../../src/services/collection-schema/field-filter";

/**
 * Field-filter SQL, pinned at the shape level.
 *
 * Two properties are load-bearing and were both broken:
 *
 *  1. `in` bound its JS array as ONE placeholder, which Drizzle expands to
 *     `ANY(($1, $2, …))` — a row constructor Postgres rejects, so every `in`
 *     filter was a 500.
 *  2. Every equality cast the COLUMN to text. Measured with EXPLAIN on 200k
 *     rows, `col::text = $1` forces a Seq Scan on numeric / timestamptz / uuid /
 *     bigint columns: the cast hides the column from its own index. The cast has
 *     to ride the VALUE instead. These assertions are what keep a future edit
 *     from quietly reintroducing an unindexable predicate.
 */

const render = (
  filter: RecordFilter,
  fieldType?: FieldDefinitionType,
): string => {
  const predicate = buildFieldFilterPredicate(filter, fieldType);
  if (!predicate) return "";
  return new PgDialect().sqlToQuery(predicate).sql;
};

describe("buildFieldFilterPredicate — the column is never cast", () => {
  const typedCases: [FieldDefinitionType, string][] = [
    ["number", "numeric"],
    ["rating", "numeric"],
    ["date", "timestamptz"],
    ["unique_id", "bigint"],
    ["location", "bigint"],
    ["boolean", "boolean"],
  ];

  const sampleValue = (type: FieldDefinitionType): string => {
    if (type === "date") return "2026-01-01T00:00:00Z";
    if (type === "boolean") return "true";
    return "42";
  };

  it.each(typedCases)("eq on %s casts the value to %s", (type, cast) => {
    const sql = render({ key: "f", op: "eq", value: sampleValue(type) }, type);
    expect(sql).toContain(`::${cast}`);
    expect(sql).not.toContain(`"f")::text`);
    expect(sql).not.toContain(`"f"::text`);
  });

  it("eq on a text field casts neither side", () => {
    const sql = render({ key: "f", op: "eq", value: "x" }, "select");
    expect(sql).not.toContain("::text");
  });

  it("eq on an UNKNOWN field keeps the old text comparison", () => {
    // No type → no safe cast. Casting the column is wrong but correct-by-default;
    // this is the one path allowed to stay unindexable.
    const sql = render({ key: "f", op: "eq", value: "x" }, undefined);
    expect(sql).toContain("::text");
  });

  it("money compares its _amount column as numeric", () => {
    const sql = render({ key: "price", op: "gte", value: "10" }, "money");
    expect(sql).toContain(`"price_amount"`);
    expect(sql).toContain("::numeric");
  });

  it("a value the cast would reject drops the filter instead of erroring", () => {
    // `'abc'::numeric` raises 22P02 mid-query; the old `::text` form merely
    // matched nothing. Dropping the predicate keeps that forgiving behaviour.
    expect(render({ key: "f", op: "eq", value: "abc" }, "number")).toBe("");
    expect(render({ key: "f", op: "eq", value: "nope" }, "date")).toBe("");
  });

  it("range operators never cast the column, even for an unknown type", () => {
    // `col::text > $1` would order numbers lexicographically ("9" > "10").
    const sql = render({ key: "f", op: "gt", value: "5" }, undefined);
    expect(sql).not.toContain("::text");
  });
});

describe("buildFieldFilterPredicate — in", () => {
  it("builds an ARRAY literal, never a bare array placeholder", () => {
    const sql = render(
      { key: "f", op: "in", value: ["a", "b", "c"] },
      "select",
    );
    expect(sql).toContain("= ANY(ARRAY[");
    expect(sql).toContain("$1, $2, $3");
    // The bug: `ANY($1)` expanded to `ANY(($1, $2, $3))`, invalid SQL.
    expect(sql).not.toMatch(/ANY\(\(/);
  });

  it("carries the column's type into the array", () => {
    const sql = render({ key: "f", op: "in", value: ["1", "2"] }, "number");
    expect(sql).toContain("::numeric[]");
  });

  it("on multi_select means overlap, not equality", () => {
    // A `text[]` column compared as text would only match one exact combination.
    const sql = render(
      { key: "tags", op: "in", value: ["a", "b"] },
      "multi_select",
    );
    expect(sql).toContain("&&");
    expect(sql).toContain("::text[]");
  });

  it("skips values the cast rejects, and drops the filter when none survive", () => {
    expect(
      render({ key: "f", op: "in", value: ["1", "x"] }, "number"),
    ).toContain("$1");
    expect(render({ key: "f", op: "in", value: ["x", "y"] }, "number")).toBe(
      "",
    );
  });

  it("drops an empty list", () => {
    expect(render({ key: "f", op: "in", value: [] }, "select")).toBe("");
  });
});

describe("buildFieldFilterPredicate — contains", () => {
  it("leaves a text column bare so a GIN pg_trgm index can serve ILIKE", () => {
    const sql = render({ key: "f", op: "contains", value: "x" }, "text");
    expect(sql).toContain("ILIKE");
    expect(sql).not.toContain("::text");
  });

  it("casts a non-text column, which is the only way to substring-match it", () => {
    const sql = render({ key: "f", op: "contains", value: "4" }, "number");
    expect(sql).toContain("::text");
    expect(sql).toContain("ILIKE");
  });

  it("on multi_select tests membership", () => {
    const sql = render(
      { key: "t", op: "contains", value: "a" },
      "multi_select",
    );
    expect(sql).toContain("@>");
  });
});
