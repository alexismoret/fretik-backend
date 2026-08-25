import { describe, expect, test } from "bun:test";
import type { FieldDefinition } from "../../src/db/schema";
import { FormulaError } from "../../src/services/collection-schema/formula/ast";
import { compileFormula } from "../../src/services/collection-schema/formula/compile";
import { parseFormula } from "../../src/services/collection-schema/formula/parse";
import { formulasToRebuildAfter } from "../../src/services/field-definitions/formula-config";

/**
 * The formula compiler is a SECURITY boundary, not a convenience: its output
 * becomes the body of a `GENERATED ALWAYS AS (…) STORED` column, composed into
 * DDL, on a connection that bypasses row-level security. Three properties carry
 * that weight and each fails silently if it breaks —
 *
 *   1. nothing an author types can reach the SQL except through a resolved
 *      column name or a re-serialised literal;
 *   2. a division can never abort the query that reads the column;
 *   3. every emitted construct is IMMUTABLE, because Postgres refuses anything
 *      else in a generated column — and the refusal arrives at DDL time, on a
 *      user's field-creation click, not here.
 *
 * The type rules are tested alongside because an inferred type is PERSISTED
 * (`config.resultType`) and decides the physical column type: getting it wrong
 * is a migration, not a bug fix.
 */

let nextId = 0;
const field = (
  key: string,
  type: FieldDefinition["type"],
  config: FieldDefinition["config"] = {},
): FieldDefinition => {
  nextId++;
  return {
    id: `00000000-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
    organizationId: "org",
    teamId: "team",
    collectionId: "type",
    key,
    label: key.replaceAll("_", " "),
    description: null,
    type,
    config,
    isTitle: false,
    aiExtractionEnabled: true,
    vectorizeInclude: true,
    displayInPanel: true,
    enabled: true,
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as FieldDefinition;
};

const FIELDS: FieldDefinition[] = [
  field("revenue", "number"),
  field("cost", "number"),
  field("fee", "money"),
  field("name", "text"),
  field("status", "select"),
  field("won", "boolean"),
  field("closed_at", "date"),
  field("opened_at", "date"),
  field("stars", "rating"),
  field("ref", "unique_id"),
  field("owner", "relation"),
  field("total_tasks", "rollup"),
  field("tags", "multi_select"),
  field("place", "location"),
  field("author", "member"),
  field("created_time", "created_time"),
];

const compile = (source: string, fields: FieldDefinition[] = FIELDS) =>
  compileFormula({ source, fields });

/** The message of the refusal a formula produces, or "" when it compiled. */
const refusal = (
  source: string,
  fields: FieldDefinition[] = FIELDS,
): string => {
  try {
    compile(source, fields);
    return "";
  } catch (error) {
    return error instanceof FormulaError ? error.message : String(error);
  }
};

/**
 * The operator at the ROOT of a parse — the only thing precedence actually
 * decides. Asserted on the tree rather than on the emitted SQL: the emitter
 * parenthesises defensively, so a string comparison would pin how many
 * redundant brackets it happens to add today instead of how the formula groups.
 */
const rootOp = (source: string): string => {
  const node = parseFormula(source);
  if (node.kind === "binary") return node.op;
  if (node.kind === "unary") return node.op;
  return node.kind;
};

describe("grammar", () => {
  test("arithmetic follows the precedence its author expects", () => {
    // `a + b * c` must group as `a + (b * c)`. The other reading computes
    // something else entirely and never announces it — a margin formula written
    // the natural way would just be quietly wrong.
    expect(rootOp("revenue + cost * 2")).toBe("+");
    expect(rootOp("revenue * cost + 2")).toBe("+");
    expect(rootOp("(revenue + cost) * 2")).toBe("*");
    // Left-associative: `a - b - c` is `(a - b) - c`, never `a - (b - c)`.
    const chain = parseFormula("revenue - cost - 2");
    expect(chain.kind === "binary" && chain.left.kind === "binary").toBe(true);
  });

  test("unary minus binds tighter than arithmetic, `not` looser than comparison", () => {
    // `-a + b` is `(-a) + b`; the root is the addition.
    expect(rootOp("-revenue + cost")).toBe("+");
    // `not a = b` is `not (a = b)`: the other reading is a type error, so a
    // parser that got this backwards would reject valid formulas.
    expect(rootOp("not won = true")).toBe("not");
    expect(compile("not won = true").resultType).toBe("boolean");
  });

  test("`and` binds tighter than `or`", () => {
    expect(rootOp("won or won and won")).toBe("or");
    expect(rootOp("won and won or won")).toBe("or");
  });

  test("nested calls parse without any special handling", () => {
    // The worry that motivated looking at a parser library: functions inside
    // function arguments. Recursive descent handles it by construction.
    const { sql, resultType } = compile(
      "round(coalesce(revenue, 0) / greatest(cost, 1), 2)",
    );
    expect(resultType).toBe("number");
    expect(sql).toContain("round(");
    expect(sql).toContain("coalesce(");
    expect(sql).toContain("greatest(");
  });

  test("a quote is escaped by doubling it, as in SQL", () => {
    // In the SOURCE, a quote is doubled to escape itself; in the OUTPUT, only
    // the single quote needs it, because that is what delimits a SQL literal.
    expect(compile('concat(name, "say ""hi""")').sql).toContain(`'say "hi"'`);
    expect(compile(`concat(name, "it's")`).sql).toContain(`'it''s'`);
  });
});

/**
 * The SQL with every string literal removed — what a Postgres parser would see
 * as structure. If a literal ever failed to escape its closing quote, its
 * contents would land HERE, which is what makes this the honest injection check:
 * asserting the escaped form merely confirms one spelling, while this confirms
 * that nothing escaped the literal at all.
 */
const outsideLiterals = (sql: string): string =>
  sql.replaceAll(/'(?:[^']|'')*'/g, "''");

describe("nothing an author writes reaches the SQL", () => {
  test.each([
    `concat(name, "'; DROP TABLE data.coll_x; --")`,
    `concat(name, "') STORED, x text GENERATED ALWAYS AS ('")`,
    `concat(name, "'||pg_read_file('/etc/passwd')||'")`,
  ])("a hostile text literal stays inside its quotes: %s", (source) => {
    // This expression is spliced into DDL. Escaping is checked by removing every
    // well-formed literal and looking at what is LEFT: if a closing quote ever
    // slipped through, the payload would show up in the structure.
    const structure = outsideLiterals(compile(source).sql);
    expect(structure).not.toContain(";");
    expect(structure.toUpperCase()).not.toContain("DROP");
    expect(structure.toUpperCase()).not.toContain("GENERATED");
    expect(structure).not.toContain("pg_read_file");
  });

  test("there is no syntax for a raw identifier, so one cannot be smuggled", () => {
    // Double quotes are a TEXT literal here, not a quoted identifier as in SQL —
    // so the SQL spelling of an injected column name is inert, and a statement
    // separator is refused by the tokenizer before anything is resolved.
    expect(compile('concat("revenue", name)').sql).toContain("'revenue'");
    expect(refusal('"revenue"; DROP TABLE x')).toContain(
      "`;` is not something a formula can use",
    );
    expect(() => parseFormula("revenue; DROP TABLE x")).toThrow(FormulaError);
  });

  test("column names come from the catalog, not from the typed text", () => {
    // `fee` is a money field: its column is `fee_amount`, which the author never
    // typed. The emitted name is derived, never echoed.
    expect(compile("fee * 2").sql).toBe('(("fee_amount") * (2))');
  });

  test("an unknown field is refused by name, never passed through", () => {
    expect(refusal("nope + 1")).toBe(
      "There is no field called `nope` on this collection.",
    );
  });

  test("an unknown function names what is available", () => {
    const message = refusal("median(revenue)");
    expect(message).toContain("There is no function called `median`");
    expect(message).toContain("round");
  });
});

describe("a formula can never take down the query that reads it", () => {
  test("division always guards its divisor with NULLIF", () => {
    // A 22012 raised inside a generated column would fail the whole SELECT for
    // every row, not just the offending one. An empty cell is the only sane
    // outcome, and it is a state the page already has to render.
    expect(compile("revenue / cost").sql).toContain('NULLIF(("cost"), 0)');
    expect(compile("revenue % cost").sql).toContain('NULLIF(("cost"), 0)');
  });

  test("division casts to numeric so integer division cannot truncate", () => {
    // `ref` is a bigint (`unique_id`). Without the cast, `ref / 2` would floor
    // in Postgres while its author reads it as a half.
    expect(compile("ref / 2").sql).toContain("::numeric");
  });
});

describe("only IMMUTABLE constructs are emitted", () => {
  test("concat uses `||`, never the STABLE concat() function", () => {
    const { sql } = compile("concat(name, name)");
    expect(sql).toContain("||");
    expect(sql).not.toContain("concat(");
  });

  test("concat defaults each part, so one empty value cannot erase the rest", () => {
    expect(compile("concat(name, name)").sql).toContain("coalesce");
  });

  test("days_between goes through epoch, never a ::date cast", () => {
    // `timestamptz::date` depends on the session TimeZone — STABLE, which
    // Postgres refuses in a generated column. Subtracting two instants gives an
    // interval, and extracting its epoch is immutable.
    const { sql, resultType } = compile("days_between(closed_at, opened_at)");
    expect(resultType).toBe("number");
    expect(sql).toContain("extract(epoch from");
    expect(sql).not.toContain("::date");
  });

  test("a date cannot be turned into text", () => {
    // Same reason, stated to the author rather than discovered as a DDL error.
    expect(refusal("text(closed_at)")).toContain("time zone");
  });
});

describe("types are inferred, never assumed", () => {
  test.each([
    ["revenue - cost", "number"],
    ["fee", "number"],
    ["ref + 1", "number"],
    ["stars * 2", "number"],
    ["concat(name, status)", "text"],
    ["upper(name)", "text"],
    ["revenue > cost", "boolean"],
    ["not won", "boolean"],
    ["length(name)", "number"],
    ["if(won, revenue, 0)", "number"],
    ["if(won, name, status)", "text"],
    ["least(closed_at, opened_at)", "date"],
    ["coalesce(revenue, cost)", "number"],
  ] as const)("`%s` is a %s", (source, expected) => {
    expect(compile(source).resultType).toBe(expected);
  });

  test("mixing kinds is refused in the author's words", () => {
    expect(refusal("revenue + name")).toContain("`+` works on numbers");
    expect(refusal("revenue = name")).toContain("cannot compare");
    expect(refusal("if(won, revenue, name)")).toContain("the same kind");
    expect(refusal("won and revenue")).toContain("yes/no");
  });

  test("a NULL literal takes the type around it", () => {
    expect(compile("coalesce(null, revenue)").resultType).toBe("number");
    expect(compile("if(won, revenue, null)").resultType).toBe("number");
  });

  test("a formula that can only ever be empty is refused", () => {
    // It would compile to a column with no type to give it.
    expect(refusal("null")).toContain("empty value");
  });
});

describe("fields a formula cannot read are refused by name", () => {
  test.each([
    ["owner + 1", "link to other records"],
    ["total_tasks + 1", "already an aggregate"],
    ["tags + 1", "several values at once"],
    ["place + 1", "place"],
    ["author + 1", "teammate"],
    ["created_time + 1", "system property"],
  ])("`%s` explains why", (source, expected) => {
    // Every one of these has a real column-less or wrong-shaped backing. Naming
    // the reason is what stops the author (or the agent) from trying variants:
    // a bare "unsupported type" invites three more attempts.
    expect(refusal(source)).toContain(expected);
  });

  test("a disabled field is not readable either", () => {
    const fields = [...FIELDS, field("legacy", "number", {})];
    const disabled = fields.map((f) =>
      f.key === "legacy" ? { ...f, enabled: false } : f,
    );
    expect(refusal("legacy + 1", disabled)).toContain("disabled");
  });
});

describe("a formula reading a formula", () => {
  const withFormulas = [
    ...FIELDS,
    field("margin", "formula", {
      expression: "revenue - cost",
      resultType: "number",
    }),
    field("margin_pct", "formula", {
      expression: "margin / revenue * 100",
      resultType: "number",
    }),
  ];

  test("is INLINED, because a generated column cannot read another one", () => {
    const { sql, resultType } = compile("round(margin_pct, 1)", withFormulas);
    expect(resultType).toBe("number");
    // The inner formula's own columns appear; its NAME never does.
    expect(sql).toContain('"revenue"');
    expect(sql).toContain('"cost"');
    expect(sql).not.toContain('"margin_pct"');
    expect(sql).not.toContain('"margin"');
  });

  test("reports the whole dependency set, through the chain", () => {
    const { dependsOn } = compile("margin_pct + 1", withFormulas);
    // `revenue` and `cost` are only reachable through `margin` — the guard that
    // refuses to delete a referenced field needs the FLAT set, or it would let
    // `cost` go and leave a column whose expression cannot be rebuilt.
    expect(new Set(dependsOn)).toEqual(
      new Set(["margin_pct", "margin", "revenue", "cost"]),
    );
  });

  test("a loop is named, not left to recurse", () => {
    const looping = [
      ...FIELDS,
      field("a", "formula", { expression: "b + 1", resultType: "number" }),
      field("b", "formula", { expression: "a + 1", resultType: "number" }),
    ];
    const message = refusal("a + 1", looping);
    expect(message).toContain("loop");
    expect(message).toContain("a");
    expect(message).toContain("b");
  });

  test("a broken inner formula is reported against the reference, not its own text", () => {
    // The author is looking at THIS formula; a position inside a field they did
    // not open would point at nothing on their screen.
    const broken = [
      ...FIELDS,
      field("bad", "formula", { expression: "nope * 2", resultType: "number" }),
    ];
    const message = refusal("bad + 1", broken);
    expect(message).toContain("its own formula fails");
    expect(message).toContain("nope");
  });

  test("a formula with no expression yet is refused rather than emitting nothing", () => {
    const empty = [...FIELDS, field("draft", "formula", {})];
    expect(refusal("draft + 1", empty)).toContain("no formula yet");
  });
});

describe("refusals are usable", () => {
  test("every refusal carries a position inside the source", () => {
    const source = "revenue + nope";
    try {
      compile(source);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      if (error instanceof FormulaError) {
        // The editor underlines from here, so it must land ON `nope`.
        expect(source.slice(error.at)).toBe("nope");
      }
    }
  });

  test.each([
    "",
    "   ",
    "revenue +",
    "revenue + (cost",
    "round(",
    ")",
    "revenue cost",
    '"unterminated',
    "12abc",
    "@revenue",
    "revenue ** cost",
  ])("`%s` fails as a named refusal, never as a crash", (source) => {
    // Anything reaching this compiler is caller text — an agent's argument or a
    // half-typed expression in a live editor. An unnamed exception there is a
    // 500 with a stack instead of a sentence pointing at the problem.
    expect(() => compile(source)).toThrow(FormulaError);
  });

  test("deep nesting stops rather than blowing the stack", () => {
    const deep = `${"(".repeat(200)}revenue${")".repeat(200)}`;
    expect(() => compile(deep)).toThrow(FormulaError);
  });
});

describe("editing a formula reaches the formulas that inline it", () => {
  /**
   * Found by MEASURING, not by reading: on a real type, editing `margin` to
   * `(revenue - cost) * 2` doubled `margin` and left `margin_pct` dividing by
   * the OLD margin — 40 where it should have read 80. Inlining is what makes a
   * generated column possible at all (Postgres refuses to let one read
   * another), and this is its price: every reader holds a COPY of the SQL.
   *
   * The failure is the dangerous kind — the stale number stays plausible.
   */
  const chain = [
    field("revenue", "number"),
    field("cost", "number"),
    field("margin", "formula", {
      expression: "revenue - cost",
      resultType: "number",
    }),
    field("margin_pct", "formula", {
      expression: "margin / revenue * 100",
      resultType: "number",
    }),
    field("pct_rounded", "formula", {
      expression: "round(margin_pct, 1)",
      resultType: "number",
    }),
    field("unrelated", "formula", {
      expression: "revenue * 2",
      resultType: "number",
    }),
  ];

  test("every formula downstream is listed, transitively", () => {
    const keys = formulasToRebuildAfter({ key: "margin", fields: chain }).map(
      (f) => f.key,
    );
    // `pct_rounded` reads `margin` only through `margin_pct` — two levels down,
    // and just as stale.
    expect(keys).toEqual(["margin_pct", "pct_rounded"]);
  });

  test("a formula is listed AFTER the one it reads", () => {
    const keys = formulasToRebuildAfter({ key: "margin", fields: chain }).map(
      (f) => f.key,
    );
    expect(keys.indexOf("margin_pct")).toBeLessThan(
      keys.indexOf("pct_rounded"),
    );
  });

  test("a formula that does not read it is left alone", () => {
    const keys = formulasToRebuildAfter({ key: "margin", fields: chain }).map(
      (f) => f.key,
    );
    // Rebuilding drops and recreates a column across every row; doing it to
    // formulas that cannot have changed is pure cost.
    expect(keys).not.toContain("unrelated");
  });

  test("a plain field's dependents are found the same way", () => {
    const keys = formulasToRebuildAfter({ key: "revenue", fields: chain }).map(
      (f) => f.key,
    );
    expect(new Set(keys)).toEqual(
      new Set(["margin", "margin_pct", "pct_rounded", "unrelated"]),
    );
  });

  test("a cycle cannot make the walk loop forever", () => {
    const looping = [
      field("a", "formula", { expression: "b + 1", resultType: "number" }),
      field("b", "formula", { expression: "a + 1", resultType: "number" }),
    ];
    // Neither compiles, so neither reports a dependency — but the walk must
    // terminate on its own rather than relying on that.
    expect(() =>
      formulasToRebuildAfter({ key: "a", fields: looping }),
    ).not.toThrow();
  });
});
