import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod.
import "@hono/zod-openapi";
import { z } from "zod";
import type { PageCompiled, PageDefinition } from "../../src/schemas/pages";
import {
  PAGE_LIMITS,
  PageDatasetSchema,
  PageDefinitionSchema,
  PageDraftDefinitionSchema,
  pageBlankError,
  pagePublishError,
  pageValueSchema,
} from "../../src/schemas/pages";
import { applyPageCodeEdits } from "../../src/services/pages/apply-code-edits";

/**
 * The gates that REFUSE a page rather than warn about it.
 *
 * Everything on the DATA half is sanitize-and-warn, and that is right: a
 * dangling reference is a best guess worth keeping the turn for. A document
 * that renders nothing is not — a write that reports success there sends the
 * agent back a URL for a blank screen, which is how prod 2026-08-09 spent 35
 * tool calls saving the same empty page.
 */

const SOURCE = "<template><h1>Hello</h1></template>";

const compiled = (): PageCompiled => ({
  js: 'import { mountPage } from "#fretik/sdk";',
  css: ".p-4{padding:1rem}",
  runtimeVersion: "v1",
  sourceHash: "a".repeat(64),
  compiledAt: "2026-01-01T00:00:00.000Z",
});

const page = (extra: Partial<PageDefinition> = {}): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: SOURCE, compiled: compiled() },
  ...extra,
});

describe("pageBlankError", () => {
  test("an empty source is refused, and the message says what to write", () => {
    const message = pageBlankError({ source: "" });
    expect(message).toContain("code.source is empty");
    expect(message).toContain("renders nothing");
    expect(message).toContain("<template>");
  });

  test("whitespace is as blank as nothing", () => {
    expect(pageBlankError({ source: "  \n\t " })).not.toBeNull();
  });

  test("any real source passes — whether it COMPILES is the compiler's job", () => {
    expect(pageBlankError({ source: SOURCE })).toBeNull();
    expect(pageBlankError({ source: "<template>broken" })).toBeNull();
  });
});

describe("pagePublishError", () => {
  test("still refuses to publish a page that renders nothing", () => {
    expect(pagePublishError(page({ code: { source: "" } }))).toBe(
      "The page has no code to publish.",
    );
  });

  test("code that never compiled cleanly cannot be published", () => {
    const error = pagePublishError(page({ code: { source: SOURCE } }));
    expect(error).toContain("never compiled");
    expect(error).toContain("publish");
  });

  /**
   * Publishing turns a page into a link anyone can open. An external dataset on
   * one would let an anonymous visitor spend the team's third-party credentials
   * — metered, rate-limited, and able to flip the connection to `error` for
   * everyone who uses it.
   */
  test("an external dataset cannot be published", () => {
    const error = pagePublishError(
      page({
        datasets: [
          {
            id: "crm",
            kind: "external",
            connectionId: "00000000-0000-4000-8000-000000000000",
            operation: "list_deals",
          },
        ],
      }),
    );
    expect(error).toContain('Dataset "crm"');
    // The message has to name the way out, not just the refusal.
    expect(error).toContain("workflow");
  });

  test("an operation cannot be published — a public link must not write", () => {
    const error = pagePublishError(
      page({
        operations: [
          {
            kind: "app" as const,
            id: "ship",
            providerKey: "acme-orders",
            action: "mark_shipped",
          },
        ],
      }),
    );
    expect(error).toContain('Operation "ship"');
    expect(error).toContain("remove its operations");
  });

  test("the same page over an object type publishes", () => {
    expect(
      pagePublishError(
        page({
          datasets: [
            {
              id: "crm",
              kind: "objects",
              objectTypeId: "00000000-0000-4000-8000-000000000000",
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("PageDefinitionSchema", () => {
  /**
   * `code` must be REQUIRED in storage: a defaulted empty page would reach the
   * model as a documented default value in the tool's JSON Schema — the schema
   * itself saying an empty page is ordinary.
   */
  test("code is required, not defaulted to an empty page", () => {
    const parsed = PageDefinitionSchema.safeParse({
      version: 3,
      datasets: [{ id: "kpi", kind: "inline", rows: [{ amount: 1 }] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a definition carrying its code parses, with or without a compile", () => {
    expect(
      PageDefinitionSchema.safeParse({
        version: 3,
        code: { source: SOURCE },
      }).success,
    ).toBe(true);
    expect(PageDefinitionSchema.safeParse(page()).success).toBe(true);
  });

  test("a compiled block is validated, not waved through", () => {
    const parsed = PageDefinitionSchema.safeParse(
      page({
        code: { source: SOURCE, compiled: { ...compiled(), sourceHash: "xx" } },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

/**
 * `PageDefinitionSchema` is `managePage`'s tool input, so it is converted to
 * JSON Schema and shipped to the model on every turn the tool is active. The
 * conversion options mirror what `@ai-sdk/provider-utils` passes.
 */
describe("the definition's JSON Schema", () => {
  const toolSchema = (): string =>
    JSON.stringify(
      z.toJSONSchema(PageDefinitionSchema, {
        target: "draft-7",
        io: "input",
        reused: "inline",
      }),
    );

  /**
   * A recursive `pageValueSchema` put a self-referencing `$defs` entry in it,
   * and Together answered `400 — tool schema contains a circular reference` to
   * EVERY call carrying the tool (measured 2026-08-09, 3/3). Nothing downstream
   * of this repo will tell us if it comes back.
   */
  test("carries no cycle — no $ref, no $defs", () => {
    const json = toolSchema();
    expect(json).not.toContain("$ref");
    expect(json).not.toContain("$defs");
  });

  test("the value leaf still validates JSON, and only JSON", () => {
    for (const value of ["x", 1, true, null, [1, [2, { a: 3 }]], { a: [1] }]) {
      expect(pageValueSchema.safeParse(value).success).toBe(true);
    }
    // The recursive union could not reject these either — the walk in
    // `isPageValue` is what makes the flat schema no weaker than what it
    // replaced.
    expect(pageValueSchema.safeParse({ a: () => 1 }).success).toBe(false);
    expect(pageValueSchema.safeParse([undefined]).success).toBe(false);
    expect(pageValueSchema.safeParse(Number.NaN).success).toBe(false);
  });
});

describe("inline dataset rows", () => {
  test("one object per row parses", () => {
    const parsed = PageDatasetSchema.safeParse({
      id: "kpi",
      kind: "inline",
      rows: [{ month: "March", amount: 134.16 }],
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * An array of arrays with a header row read as data everywhere it was bound
   * and reported no error, so the agent kept re-sending variants of it.
   */
  test("an array of arrays is refused", () => {
    const parsed = PageDatasetSchema.safeParse({
      id: "kpi",
      kind: "inline",
      rows: [
        ["month", "amount"],
        ["March", 134.16],
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test("a bare scalar row is refused", () => {
    const parsed = PageDatasetSchema.safeParse({
      id: "kpi",
      kind: "inline",
      rows: [134.16],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The targeted-edit channel — the artifact-style alternative to re-sending the
 * whole SFC, which is the exact move that drops a line that was fine. Exact
 * match, once, in order; anything ambiguous is a STALE VIEW and refuses with
 * the way out.
 */
describe("applyPageCodeEdits", () => {
  const source =
    "<template>\n  <h1>Pipeline</h1>\n  <p>Pipeline</p>\n</template>";

  test("one edit reaches its exact text", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "<h1>Pipeline</h1>", newString: "<h1>2026</h1>" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toContain("<h1>2026</h1>");
      expect(result.source).toContain("<p>Pipeline</p>");
    }
  });

  test("an oldString that matches nothing refuses and says how to re-anchor", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "<h1>Sales</h1>", newString: "<h1>2026</h1>" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
      expect(result.error).toContain('"get"');
    }
  });

  test("an ambiguous match refuses rather than guessing an occurrence", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "Pipeline", newString: "2026" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("2 times");
      expect(result.error).toContain("replaceAll");
    }
  });

  test("replaceAll changes every occurrence", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "Pipeline", newString: "2026", replaceAll: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).not.toContain("Pipeline");
  });

  test("edits apply in order — a later edit may target what an earlier one wrote", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "<h1>Pipeline</h1>", newString: "<h1>Deals</h1>" },
      { oldString: "<h1>Deals</h1>", newString: "<h1>Deals 2026</h1>" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toContain("<h1>Deals 2026</h1>");
  });

  test("an edit that changes nothing is refused by name", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "Pipeline", newString: "Pipeline" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("identical");
  });

  test("an edit may not push the source past the size ceiling", () => {
    const nearCeiling = `${"a".repeat(PAGE_LIMITS.maxSourceChars - 10)}MARKER`;
    const over = applyPageCodeEdits(nearCeiling, [
      { oldString: "MARKER", newString: "b".repeat(100) },
    ]);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("ceiling");
  });
});

/**
 * The author-facing definition allows a page to be OPENED before it is drawn —
 * the data-first draft path: datasets in one call, the SFC in the next.
 * Storage still requires `code`; a stored page without one reaches the
 * renderer.
 */
describe("PageDraftDefinitionSchema", () => {
  const datasetsOnly = {
    version: 3,
    variables: [],
    datasets: [{ id: "kpi", kind: "inline", rows: [{ label: "a", value: 1 }] }],
  };

  test("a definition without code is accepted from an author", () => {
    const parsed = PageDraftDefinitionSchema.safeParse(datasetsOnly);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.code).toBeUndefined();
  });

  test("the same definition is REFUSED by the storage schema", () => {
    expect(PageDefinitionSchema.safeParse(datasetsOnly).success).toBe(false);
  });

  test("supplied code is still validated, not waved through", () => {
    const parsed = PageDraftDefinitionSchema.safeParse({
      ...datasetsOnly,
      code: { source: 123 },
    });
    expect(parsed.success).toBe(false);
  });

  test("code stays visible in the JSON Schema the model reads, just not required", () => {
    const json = JSON.stringify(
      z.toJSONSchema(PageDraftDefinitionSchema, {
        target: "draft-7",
        io: "input",
        reused: "inline",
      }),
    );
    const parsed: unknown = JSON.parse(json);
    const required =
      typeof parsed === "object" && parsed !== null && "required" in parsed
        ? parsed.required
        : null;
    expect(json).toContain('"source"');
    expect(Array.isArray(required) && required.includes("code")).toBe(false);
  });
});

/**
 * The near-miss window. A failed anchor is nearly always a whitespace drift,
 * not a wrong place — measured on a real run (2026-08-16) where the agent
 * reported "the anchors have a different indentation from the saved code" and
 * then resent the whole SFC twice. Telling it to `get` and re-anchor made that
 * retreat rational: a full read costs what a full rewrite costs, so it did
 * both. Handing back the real lines removes the reason for either.
 */
describe("applyPageCodeEdits near-miss", () => {
  const source = [
    "<template>",
    "  <section>",
    "        <h1>Pipeline</h1>",
    "  </section>",
    "</template>",
  ].join("\n");

  test("an anchor off by indentation gets the exact line back", () => {
    // Re-indented by hand, the way a model rewrites a block from memory: the
    // text is right, the whitespace between the lines is not.
    const result = applyPageCodeEdits(source, [
      {
        oldString: "  <section>\n    <h1>Pipeline</h1>",
        newString: "  <section>\n    <h1>2026</h1>",
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("line 2");
      // The real text, indentation included, is what makes a second attempt
      // land without a re-read.
      expect(result.error).toContain("        <h1>Pipeline</h1>");
      // No point telling it to `get` when the answer is already here.
      expect(result.error).not.toContain('"get"');
    }
  });

  test("an anchor aimed at text the page never had says so plainly", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "<h1>Forecast revenue</h1>", newString: "<h1>2026</h1>" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nothing close");
      expect(result.error).toContain('"get"');
    }
  });

  test("an ambiguous probe stays silent rather than pointing anywhere", () => {
    const repeated = "  <p>Row</p>\n  <p>Row</p>\n  <p>Row</p>";
    const result = applyPageCodeEdits(repeated, [
      { oldString: "<p>Row</p>\n<p>Row</p>", newString: "<p>One</p>" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nothing close");
  });

  // A probe shorter than the threshold would match half the file; the window
  // would point at a coincidence and read as authoritative.
  test("a tiny anchor produces no window", () => {
    const result = applyPageCodeEdits(source, [
      { oldString: "<b>", newString: "<i>" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nothing close");
  });
});
