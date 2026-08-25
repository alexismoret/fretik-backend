import { describe, expect, test } from "bun:test";
import { parseFormula } from "../../src/services/collection-schema/formula/parse";
import {
  normalizeFormula,
  printFormula,
} from "../../src/services/collection-schema/formula/print";

/**
 * Printing exists so a formula can be BUILT by clicking instead of typed, and
 * the property the whole visual editor rests on is the round trip: a tree
 * printed to text and read back must be the SAME tree.
 *
 * If it is not, the failure is quiet and nasty — the builder shows one formula,
 * the database computes another. Precedence is where that would happen, because
 * the printer emits brackets from binding power rather than copying them from
 * an input it never saw.
 */

const EXPRESSIONS = [
  "revenue",
  "revenue - cost",
  "revenue + cost * 2",
  "(revenue + cost) * 2",
  "revenue - cost - 2",
  "revenue - (cost - 2)",
  "revenue / cost / 2",
  "revenue / (cost / 2)",
  "-revenue + cost",
  "-(revenue + cost)",
  "not won",
  "not won and open",
  "not (won and open)",
  "won or open and late",
  "(won or open) and late",
  "revenue > cost",
  "round(revenue / cost, 2)",
  "round(coalesce(revenue, 0) / greatest(cost, 1), 2)",
  'if(status = "won", amount, 0)',
  'concat(name, " — ", status)',
  'concat(name, "say ""hi""")',
  "days_between(closed_at, opened_at)",
  "least(a, b, c, d)",
  "null",
  "true",
  "false",
  "1.5",
  "-3",
];

describe("a printed tree reads back as the same tree", () => {
  test.each(EXPRESSIONS)("%s", (source) => {
    const once = normalizeFormula(source);
    // Structural equality, not string equality: the printer normalises spacing
    // and drops redundant brackets, so the TREES are what must match.
    expect(parseFormula(once)).toEqual(parseFormula(source));
  });

  test.each(EXPRESSIONS)("printing is idempotent: %s", (source) => {
    // A second pass must change nothing — otherwise every save of an untouched
    // formula would rewrite its text and look like an edit.
    const once = normalizeFormula(source);
    expect(normalizeFormula(once)).toBe(once);
  });
});

describe("brackets are emitted from precedence, not copied", () => {
  test("redundant brackets are dropped", () => {
    expect(normalizeFormula("(revenue) + ((cost))")).toBe("revenue + cost");
    expect(normalizeFormula("revenue + (cost * 2)")).toBe("revenue + cost * 2");
  });

  test("brackets that change the value are kept", () => {
    // The whole point: a tree assembled by clicking has no brackets of its own,
    // so the printer has to add exactly the ones the grouping requires.
    expect(normalizeFormula("(revenue + cost) * 2")).toBe(
      "(revenue + cost) * 2",
    );
    // Left-associativity: `a - (b - c)` must keep its brackets even though both
    // operators bind equally.
    expect(normalizeFormula("revenue - (cost - 2)")).toBe(
      "revenue - (cost - 2)",
    );
    expect(normalizeFormula("revenue - cost - 2")).toBe("revenue - cost - 2");
  });

  test("a tree built without brackets prints them where they are needed", () => {
    // What the visual builder actually produces: nesting an addition inside a
    // multiplication, with no notion of grouping anywhere in the tree.
    const tree = parseFormula("x");
    const built = {
      kind: "binary" as const,
      op: "*" as const,
      left: parseFormula("revenue + cost"),
      right: { kind: "number" as const, value: 2, at: 0 },
      at: 0,
    };
    expect(tree.kind).toBe("field");
    expect(printFormula(built)).toBe("(revenue + cost) * 2");
  });
});

describe("literals survive the trip", () => {
  test("a quote in text is re-escaped by doubling", () => {
    const printed = normalizeFormula(`concat(a, "it""s")`);
    expect(printed).toBe(`concat(a, "it""s")`);
    expect(parseFormula(printed)).toEqual(parseFormula(`concat(a, "it""s")`));
  });

  test("a single-quoted literal is reprinted with double quotes", () => {
    // The language accepts both spellings; the printer settles on one, and the
    // tree is unchanged — which is exactly what the round-trip test asserts.
    expect(normalizeFormula(`concat(a, 'hi')`)).toBe(`concat(a, "hi")`);
  });
});
