import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import type { PageDataset, PageDefinition } from "../../src/schemas/pages";
import { PAGE_LIMITS } from "../../src/schemas/pages";
import {
  pushPagePolish,
  pushPageWarning,
  sanitizePageDefinition,
} from "../../src/services/pages/sanitize";

/**
 * `sanitizePageDefinition` covers the DATA half only — datasets, variables,
 * operations. The presentation half (the Vue SFC) belongs to the COMPILER,
 * which refuses instead of warning; nothing about `code` is checked here.
 *
 * The two channels are tested apart on purpose: `warnings` is broken (a
 * reference to nothing, code that cannot return), `polish` works but reads as
 * unfinished. Merging one into the other would change what the model believes
 * about its own output.
 */

const OBJECT_TYPE_ID = "00000000-0000-4000-8000-000000000000";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";

const definition = (extra: Partial<PageDefinition> = {}): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "<template><div>x</div></template>" },
  ...extra,
});

describe("sanitize, don't reject", () => {
  test("the definition comes back untouched, whatever it warned about", () => {
    const input = definition({
      datasets: [{ id: "ghost_reader", kind: "transform", code: "1 + 1" }],
    });
    const result = sanitizePageDefinition(input);
    expect(result.definition).toBe(input);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("a clean definition raises neither warnings nor polish", () => {
    const { warnings, polish } = sanitizePageDefinition(
      definition({
        variables: [{ key: "stage", type: "string", initial: "won" }],
        datasets: [
          {
            id: "deals",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "stage", op: "eq", value: { var: "stage" } }],
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
    expect(polish).toEqual([]);
  });
});

describe("variable references", () => {
  test("a filter var-ref to a declared variable is clean", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        variables: [{ key: "month", type: "string" }],
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "month", op: "eq", value: { var: "month" } }],
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });

  test("a filter var-ref to an undeclared variable warns, naming where", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [{ key: "month", op: "eq", value: { var: "week" } }],
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"week"'));
    expect(found).toBeDefined();
    expect(found).toContain('dataset "sales" filter "month"');
    expect(found).toContain("does not declare");
  });

  test("an external dataset's args are walked at any depth", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "inbox",
            kind: "external",
            providerKey: "acme-mail",
            operation: "list_messages",
            args: { query: { folders: [{ var: "folder" }] } },
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"folder"'));
    expect(found).toBeDefined();
    expect(found).toContain('dataset "inbox" args');
  });

  test("an operation's args are checked the same way", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        operations: [
          {
            id: "create",
            providerKey: "acme-orders",
            action: "create_order",
            args: { reference: { var: "reference" } },
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('"reference"'));
    expect(found).toBeDefined();
    expect(found).toContain('operation "create" args');
  });
});

describe("transforms", () => {
  test("code that never returns warns — an empty dataset would read as 'no rows'", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "totals",
            kind: "transform",
            code: "data.sales.map(r => r.amount)",
          },
        ],
      }),
    );
    const found = warnings.find((w) => w.includes('dataset "totals"'));
    expect(found).toBeDefined();
    expect(found).toContain("never returns");
  });

  test("code that returns says nothing", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          { id: "totals", kind: "transform", code: "return [{ n: 1 }];" },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });

  test("a transform reading an oversized records input is POLISH, not a warning", () => {
    const big: PageDataset = {
      id: "big",
      kind: "objects",
      mode: "records",
      objectTypeId: OBJECT_TYPE_ID,
      limit: 2000,
    };
    const { warnings, polish } = sanitizePageDefinition(
      definition({
        datasets: [
          big,
          {
            id: "derived",
            kind: "transform",
            inputs: ["big"],
            code: "return data.big;",
          },
        ],
      }),
    );
    const found = polish.find((p) => p.includes('dataset "derived"'));
    expect(found).toBeDefined();
    expect(found).toContain("2000 rows");
    expect(found).toContain("aggregate dataset");
    expect(warnings).toEqual([]);
  });

  test("a modest input raises nothing — the query already reduced it", () => {
    const { polish } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "small",
            kind: "objects",
            mode: "records",
            objectTypeId: OBJECT_TYPE_ID,
            limit: 100,
          },
          {
            id: "derived",
            kind: "transform",
            inputs: ["small"],
            code: "return data.small;",
          },
        ],
      }),
    );
    expect(polish).toEqual([]);
  });
});

describe("dataset inputs", () => {
  test("an input no dataset declares is warned by name", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "derived",
            kind: "transform",
            inputs: ["nowhere"],
            code: "return [];",
          },
        ],
      }),
    );
    expect(warnings).toContain(
      'dataset "derived": input "nowhere" does not exist',
    );
  });

  test("a dataset feeding itself is warned", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "loop",
            kind: "transform",
            inputs: ["loop"],
            code: "return data.loop;",
          },
        ],
      }),
    );
    expect(warnings).toContain('dataset "loop": cannot take itself as input');
  });
});

describe("inline rows", () => {
  test("rows past the byte cap are warned, naming the way out", () => {
    const oversized = "x".repeat(PAGE_LIMITS.maxInlineBytes);
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [{ id: "dump", kind: "inline", rows: [{ blob: oversized }] }],
      }),
    );
    const found = warnings.find((w) => w.includes('dataset "dump"'));
    expect(found).toBeDefined();
    expect(found).toContain(
      `${Math.round(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB cap`,
    );
    expect(found).toContain("object type");
  });

  test("rows within the cap say nothing", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          { id: "targets", kind: "inline", rows: [{ q: "Q1", target: 100 }] },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });
});

describe("external datasets", () => {
  const external = (extra: Partial<PageDataset>): PageDataset => ({
    id: "inbox",
    kind: "external",
    providerKey: "acme-mail",
    operation: "list_messages",
    ...extra,
  });

  test("a plain dot path with indices passes", () => {
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [external({ resultPath: "value.items[0].rows" })],
      }),
    );
    expect(warnings).toEqual([]);
  });

  test("anything else is warned — it would resolve to nothing", () => {
    for (const resultPath of [
      "value..items",
      "items[*]",
      "value.items[abc]",
      "a b",
    ]) {
      const { warnings } = sanitizePageDefinition(
        definition({ datasets: [external({ resultPath })] }),
      );
      const found = warnings.find((w) => w.includes(resultPath));
      expect(found).toBeDefined();
      expect(found).toContain("not a plain dot path");
    }
  });

  test("naming both connectionId and providerKey is a POLISH note — the pin wins", () => {
    const { warnings, polish } = sanitizePageDefinition(
      definition({
        datasets: [external({ connectionId: CONNECTION_ID })],
      }),
    );
    expect(polish.some((p) => p.includes("the pin wins"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("a bare pin gets the per-viewer note; a bare providerKey gets none", () => {
    const pinnedOnly = sanitizePageDefinition(
      definition({
        datasets: [
          external({ connectionId: CONNECTION_ID, providerKey: undefined }),
        ],
      }),
    );
    expect(
      pinnedOnly.polish.some((p) => p.includes("pins one connection")),
    ).toBe(true);

    const providerOnly = sanitizePageDefinition(
      definition({ datasets: [external({})] }),
    );
    expect(providerOnly.polish).toEqual([]);
  });

  test("operations carry the same pin notes", () => {
    const { polish } = sanitizePageDefinition(
      definition({
        operations: [
          {
            id: "create",
            connectionId: CONNECTION_ID,
            providerKey: "acme-orders",
            action: "create_order",
          },
        ],
      }),
    );
    expect(
      polish.some(
        (p) => p.includes('operation "create"') && p.includes("the pin wins"),
      ),
    ).toBe(true);
  });
});

describe("warnings never duplicate", () => {
  test("pushPageWarning drops a message it already holds", () => {
    const warnings: string[] = [];
    pushPageWarning(warnings, "same finding");
    pushPageWarning(warnings, "same finding");
    pushPageWarning(warnings, "another finding");
    expect(warnings).toEqual(["same finding", "another finding"]);
  });

  test("pushPagePolish deduplicates the same way", () => {
    const polish: string[] = [];
    pushPagePolish(polish, "same note");
    pushPagePolish(polish, "same note");
    expect(polish).toEqual(["same note"]);
  });

  test("two identical findings through the sanitizer land once", () => {
    // Two filters on the same key referencing the same undeclared variable
    // produce byte-identical messages — the reader must see one.
    const { warnings } = sanitizePageDefinition(
      definition({
        datasets: [
          {
            id: "sales",
            kind: "objects",
            objectTypeId: OBJECT_TYPE_ID,
            filters: [
              { key: "month", op: "eq", value: { var: "week" } },
              { key: "month", op: "neq", value: { var: "week" } },
            ],
          },
        ],
      }),
    );
    expect(warnings).toHaveLength(1);
  });
});
