import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod.
import "@hono/zod-openapi";
import { z } from "zod";
import type {
  PageDefinition,
  PageDefinitionPatch,
} from "../../src/schemas/pages";
import {
  PageDatasetSchema,
  PageDefinitionSchema,
  PageDraftDefinitionSchema,
  pageBlankError,
  pagePublishError,
  pageValueSchema,
} from "../../src/schemas/pages";
import { applyPageDefinitionPatch } from "../../src/services/pages/patch";

/**
 * The gates that REFUSE a page rather than warn about it.
 *
 * Everything else on a definition is sanitize-and-warn, and that is right: an
 * off-catalog prop is a best guess worth keeping the turn for. A document that
 * renders nothing is not — a write that reports success there sends the agent
 * back a URL for a blank screen, which is how prod 2026-08-09 spent 35 tool
 * calls saving the same empty page.
 */
describe("pageBlankError", () => {
  test("an empty elements map is refused, and the message says what to write", () => {
    const message = pageBlankError({ root: "root", elements: {} });
    expect(message).toContain("spec.elements is empty");
    expect(message).toContain("renders nothing");
  });

  test("an empty root is refused, and the message lists candidate keys", () => {
    const message = pageBlankError({
      root: "",
      elements: { header: { type: "heading" }, body: { type: "box" } },
    });
    expect(message).toContain("spec.root is empty");
    expect(message).toContain("header");
  });

  test("a root naming no element is refused", () => {
    const message = pageBlankError({
      root: "main",
      elements: { header: { type: "heading" } },
    });
    expect(message).toContain('spec.root is "main"');
    expect(message).toContain("header");
  });

  test("a resolvable root passes — unreachable siblings are the sanitizer's job", () => {
    expect(
      pageBlankError({
        root: "root",
        elements: { root: { type: "box" }, orphan: { type: "text" } },
      }),
    ).toBeNull();
  });
});

describe("pagePublishError", () => {
  test("still refuses to publish a page that renders nothing", () => {
    expect(
      pagePublishError({
        version: 2,
        variables: [],
        datasets: [],
        spec: { root: "root", elements: {} },
      }),
    ).toBe("The page needs a root element to publish.");
  });

  /**
   * Publishing turns a page into a link anyone can open. An external dataset on
   * one would let an anonymous visitor spend the team's third-party credentials
   * — metered, rate-limited, and able to flip the connection to `error` for
   * everyone who uses it.
   */
  const withDataset = (
    dataset: PageDefinition["datasets"][number],
  ): PageDefinition => ({
    version: 2,
    variables: [],
    datasets: [dataset],
    spec: { root: "root", elements: { root: { type: "box" } } },
  });

  test("an external dataset cannot be published", () => {
    const error = pagePublishError(
      withDataset({
        id: "crm",
        kind: "external",
        connectionId: "00000000-0000-4000-8000-000000000000",
        operation: "list_deals",
      }),
    );
    expect(error).toContain('Dataset "crm"');
    // The message has to name the way out, not just the refusal.
    expect(error).toContain("workflow");
  });

  test("the same page over an object type publishes", () => {
    expect(
      pagePublishError(
        withDataset({
          id: "crm",
          kind: "objects",
          objectTypeId: "00000000-0000-4000-8000-000000000000",
        }),
      ),
    ).toBeNull();
  });
});

describe("PageDefinitionSchema", () => {
  /**
   * `spec` used to default to `{ root: "", elements: {} }`, which reached the
   * model as a documented default value in the tool's JSON Schema — the schema
   * itself saying an empty page is ordinary.
   */
  test("spec is required, not defaulted to an empty page", () => {
    const parsed = PageDefinitionSchema.safeParse({
      version: 2,
      datasets: [{ id: "kpi", kind: "inline", rows: [{ amount: 1 }] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a definition carrying its spec parses", () => {
    const parsed = PageDefinitionSchema.safeParse({
      version: 2,
      spec: { root: "root", elements: { root: { type: "box" } } },
    });
    expect(parsed.success).toBe(true);
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
 * The patch channel is rooted at the DEFINITION, not at `spec`.
 *
 * Before, only the spec half was patchable, so changing one dataset filter
 * forced the agent to re-send the whole document — the exact move that drops an
 * element that was fine. These pin the reach of a single op and, more
 * importantly, the re-parse: json-render's applier does NOT throw on an
 * out-of-range array index, so without it a bad path would reach storage.
 */
describe("applyPageDefinitionPatch", () => {
  const definition: PageDefinition = {
    version: 2,
    variables: [{ key: "stage", type: "string", initial: "won" }],
    datasets: [
      {
        id: "deals",
        kind: "objects",
        objectTypeId: "019f10cd-12e0-73e6-b781-ab61ff781f5a",
        mode: "records",
        filters: [{ key: "stage", op: "eq", value: "won" }],
      },
    ],
    spec: {
      root: "page",
      elements: {
        page: { type: "grid", children: ["title"] },
        title: { type: "heading", props: { text: "Pipeline" } },
      },
    },
  };

  const applied = (patch: PageDefinitionPatch): PageDefinition => {
    const result = applyPageDefinitionPatch(definition, patch);
    if ("error" in result) throw new Error(result.error);
    return result.definition;
  };

  test("one op reaches an element's prop", () => {
    const next = applied([
      { op: "replace", path: "/spec/elements/title/props/text", value: "2026" },
    ]);
    expect(next.spec.elements.title?.props?.text).toBe("2026");
  });

  test("one op reaches a dataset filter — the half that had no channel", () => {
    const next = applied([
      { op: "replace", path: "/datasets/0/filters/0/value", value: "lost" },
    ]);
    const [dataset] = next.datasets;
    expect(dataset?.kind === "objects" && dataset.filters?.[0]?.value).toBe(
      "lost",
    );
  });

  test("one op reaches a variable and one adds an element", () => {
    const next = applied([
      { op: "replace", path: "/variables/0/initial", value: "lost" },
      {
        op: "add",
        path: "/spec/elements/total",
        value: { type: "stat", props: { label: "Total" } },
      },
    ]);
    expect(next.variables[0]?.initial).toBe("lost");
    expect(next.spec.elements.total?.type).toBe("stat");
  });

  test("the source document is never mutated", () => {
    applied([
      { op: "replace", path: "/spec/elements/title/props/text", value: "2026" },
    ]);
    expect(definition.spec.elements.title?.props?.text).toBe("Pipeline");
  });

  test("a patch that produces an invalid definition is refused, not stored", () => {
    const result = applyPageDefinitionPatch(definition, [
      { op: "replace", path: "/spec/elements/title/type", value: "not_a_type" },
    ]);
    expect("error" in result && result.error).toContain("no longer valid");
  });

  test("an out-of-range index is caught by the re-parse, not by the applier", () => {
    const result = applyPageDefinitionPatch(definition, [
      { op: "replace", path: "/datasets/9/id", value: "ghost" },
    ]);
    expect("error" in result).toBe(true);
  });
});

/**
 * The author-facing definition allows a page to be OPENED before it is drawn.
 *
 * Measured 2026-08-10 by replaying the production request per upstream: one
 * pool member writes `spec.elements` 0 times in 28 through the nested
 * `definition` path and 15 times in 16 through `patch`. Storage still requires
 * a spec — a stored page without one reaches the renderer.
 */
describe("PageDraftDefinitionSchema", () => {
  const datasetsOnly = {
    version: 2,
    variables: [],
    datasets: [{ id: "kpi", kind: "inline", rows: [{ label: "a", value: 1 }] }],
  };

  test("a definition without a spec is accepted from an author", () => {
    const parsed = PageDraftDefinitionSchema.safeParse(datasetsOnly);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.spec).toBeUndefined();
  });

  test("the same definition is REFUSED by the storage schema", () => {
    expect(PageDefinitionSchema.safeParse(datasetsOnly).success).toBe(false);
  });

  test("a supplied spec is still validated, not waved through", () => {
    const parsed = PageDraftDefinitionSchema.safeParse({
      ...datasetsOnly,
      spec: { root: "page", elements: { page: { type: "not_a_component" } } },
    });
    expect(parsed.success).toBe(false);
  });

  test("spec stays visible in the JSON Schema the model reads, just not required", () => {
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
    expect(json).toContain('"elements"');
    expect(Array.isArray(required) && required.includes("spec")).toBe(false);
  });
});
