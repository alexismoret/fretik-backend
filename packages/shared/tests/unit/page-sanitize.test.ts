import { describe, expect, test } from "bun:test";
// `schemas/ontology` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod. In a service
// that happens at boot; here it has to be imported for the side effect.
import "@hono/zod-openapi";
import type { PageDefinition, PageElement } from "../../src/schemas/pages";
import {
  PAGE_LIMITS,
  PageDefinitionSchema,
  describePageDataContract,
} from "../../src/schemas/pages";
import { sanitizePageDefinition } from "../../src/services/pages/sanitize";

/**
 * `sanitizePageDefinition` is the write-side gate: what it drops the renderer
 * never sees, what it warns about is what the agent reads back, and what it
 * silently fixes is what the agent never has to learn.
 *
 * The three channels are tested apart on purpose — merging a coercion into a
 * warning, or a `polish` note into a `warnings` entry, would change what the
 * model believes about its own output.
 */

/** A page whose root is a box holding every element passed in. */
const page = (
  elements: Record<string, PageElement>,
  extra: Partial<PageDefinition> = {},
): PageDefinition => ({
  version: 2,
  variables: [],
  datasets: [],
  operations: [],
  spec: {
    root: "root",
    elements: {
      root: { type: "box", children: Object.keys(elements) },
      ...elements,
    },
  },
  ...extra,
});

const propsOf = (
  definition: PageDefinition,
  key: string,
): Record<string, unknown> => definition.spec.elements[key]?.props ?? {};

describe("coercions — fixed silently, never warned", () => {
  test("a numeric span becomes its string form", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ a: { type: "text", props: { span: 4, text: "x" } } }),
    );
    expect(propsOf(definition, "a")["span"]).toBe("4");
    expect(warnings).toEqual([]);
  });

  test("a numeric cols becomes its string form", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ g: { type: "grid", props: { cols: 3 } } }),
    );
    expect(propsOf(definition, "g")["cols"]).toBe("3");
    expect(warnings).toEqual([]);
  });

  test("a pixel chart height snaps onto the size scale", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ c: { type: "chart_bar", props: { dataset: "d", height: 280 } } }),
    );
    expect(propsOf(definition, "c")["height"]).toBe("md");
    // The dataset does not exist, so that IS warned — but not the height.
    expect(warnings.some((w) => w.includes("height"))).toBe(false);
  });

  test("a span outside the scale is still dropped with a warning", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ a: { type: "text", props: { span: 99, text: "x" } } }),
    );
    expect(propsOf(definition, "a")["span"]).toBeUndefined();
    expect(warnings.join(" ")).toContain("span");
  });
});

describe("the flat map's own failure modes", () => {
  test("an element inside its own subtree loses the back-reference", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({
        a: { type: "box", children: ["b"] },
        b: { type: "box", children: ["a"] },
      }),
    );
    expect(definition.spec.elements["b"]?.children).toBeUndefined();
    expect(warnings.join(" ")).toContain("render forever");
  });

  test("a child key naming nothing is reported and pruned", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ a: { type: "box", children: ["ghost"] } }),
    );
    expect(definition.spec.elements["a"]?.children).toBeUndefined();
    expect(warnings.join(" ")).toContain('child "ghost" does not exist');
  });

  test("an element no parent names is reported", () => {
    const { warnings } = sanitizePageDefinition({
      ...page({}),
      spec: {
        root: "root",
        elements: {
          root: { type: "box" },
          lost: { type: "text", props: { text: "x" } },
        },
      },
    });
    expect(warnings.join(" ")).toContain("not reachable");
  });

  test("`visible` written inside props is moved onto the element", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({
        a: { type: "text", props: { text: "x", visible: { $: "true" } } },
      }),
    );
    expect(definition.spec.elements["a"]?.visible).toEqual({ $: "true" });
    expect(propsOf(definition, "a")["visible"]).toBeUndefined();
    expect(warnings.join(" ")).toContain("moved");
  });

  test("an unknown component type takes the element out of the map", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({ a: { type: "carousel", props: {} } }),
    );
    expect(definition.spec.elements["a"]).toBeUndefined();
    expect(warnings.join(" ")).toContain("unknown type");
  });
});

describe("state bindings", () => {
  const withMonth: Partial<PageDefinition> = {
    variables: [{ key: "month", type: "string" }],
  };

  test("a control bound to a declared variable is clean", () => {
    const { warnings } = sanitizePageDefinition(
      page(
        { s: { type: "input", props: { value: { $bindState: "/month" } } } },
        withMonth,
      ),
    );
    expect(warnings).toEqual([]);
  });

  test("a control bound to an undeclared variable is warned", () => {
    const { warnings } = sanitizePageDefinition(
      page({ s: { type: "input", props: { value: { $bindState: "/week" } } } }),
    );
    expect(warnings.join(" ")).toContain('no variable "week" is declared');
  });

  test("a control given a fixed value is warned — it looks live and is not", () => {
    const { warnings } = sanitizePageDefinition(
      page({ s: { type: "input", props: { value: "march" } } }),
    );
    expect(warnings.join(" ")).toContain(
      "nothing the viewer does can change it",
    );
  });

  test("setState pointing at an undeclared variable is warned", () => {
    const { warnings } = sanitizePageDefinition(
      page({
        b: {
          type: "button",
          props: { label: "Go" },
          on: {
            click: { action: "setState", params: { statePath: "/week" } },
          },
        },
      }),
    );
    expect(warnings.join(" ")).toContain('no variable "week" is declared');
  });

  test("a handler for an event the component never fires is dropped", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({
        b: {
          type: "button",
          props: { label: "Go" },
          on: { row_click: { action: "resetState" } },
        },
      }),
    );
    expect(definition.spec.elements["b"]?.on).toBeUndefined();
    expect(warnings.join(" ")).toContain("dropped handler");
  });
});

describe("table cells", () => {
  const table = (cells: Record<string, PageElement>): PageDefinition => ({
    ...page({}),
    datasets: [{ id: "rows", kind: "inline", rows: [] }],
    spec: {
      root: "t",
      elements: {
        t: {
          type: "table",
          props: { dataset: "rows" },
          children: Object.keys(cells),
        },
        ...cells,
      },
    },
  });

  test("a whitelisted cell subtree survives", () => {
    const { definition, warnings } = sanitizePageDefinition(
      table({
        c: { type: "table_cell", props: { column: "status" }, children: ["b"] },
        b: { type: "badge", props: { label: "x" } },
      }),
    );
    expect(definition.spec.elements["b"]?.type).toBe("badge");
    expect(warnings).toEqual([]);
  });

  test("a component outside the cell whitelist is reported", () => {
    const { warnings } = sanitizePageDefinition(
      table({
        c: { type: "table_cell", props: { column: "status" }, children: ["x"] },
        x: { type: "chart_bar", props: { dataset: "rows" } },
      }),
    );
    expect(warnings.join(" ")).toContain("not allowed inside a table cell");
  });

  test("a table_cell anywhere but under a table is reported", () => {
    const { warnings } = sanitizePageDefinition(
      page({
        c: { type: "table_cell", props: { column: "x" } },
      }),
    );
    expect(warnings.join(" ")).toContain("direct child of a table");
  });

  test("custom cells cap the table's page size", () => {
    const { definition } = sanitizePageDefinition({
      ...page({}),
      datasets: [{ id: "rows", kind: "inline", rows: [] }],
      spec: {
        root: "t",
        elements: {
          t: {
            type: "table",
            props: { dataset: "rows", pageSize: 500 },
            children: ["c"],
          },
          c: { type: "table_cell", props: { column: "a" } },
        },
      },
    });
    expect(propsOf(definition, "t")["pageSize"]).toBe(
      PAGE_LIMITS.maxCellPageSize,
    );
  });
});

describe("warnings vs polish", () => {
  test("a chart over a seriesBy dataset without `series` is a WARNING", () => {
    const { warnings, polish } = sanitizePageDefinition(
      page(
        { c: { type: "chart_bar", props: { dataset: "agg" } } },
        {
          datasets: [
            {
              id: "agg",
              kind: "objects",
              mode: "aggregate",
              objectTypeId: "00000000-0000-4000-8000-000000000000",
              groupBy: "month",
              seriesBy: "team",
              metrics: [{ name: "total", fn: "count", label: "Total" }],
            },
          ],
        },
      ),
    );
    expect(warnings.join(" ")).toContain("series");
    expect(polish.join(" ")).not.toContain("series:");
  });

  test("an unlabelled cryptic metric is POLISH, not a warning", () => {
    const { warnings, polish } = sanitizePageDefinition(
      page(
        {},
        {
          datasets: [
            {
              id: "agg",
              kind: "objects",
              mode: "aggregate",
              objectTypeId: "00000000-0000-4000-8000-000000000000",
              groupBy: "month",
              metrics: [{ name: "nb", fn: "count" }],
            },
          ],
        },
      ),
    );
    expect(polish.join(" ")).toContain("nb");
    expect(warnings).toEqual([]);
  });

  test("a labelled metric raises nothing", () => {
    const { polish } = sanitizePageDefinition(
      page(
        {},
        {
          datasets: [
            {
              id: "agg",
              kind: "objects",
              mode: "aggregate",
              objectTypeId: "00000000-0000-4000-8000-000000000000",
              groupBy: "month",
              metrics: [{ name: "nb", fn: "count", label: "Shipments" }],
            },
          ],
        },
      ),
    );
    expect(polish).toEqual([]);
  });

  /**
   * A table over a records dataset pages SERVER-SIDE once the type outgrows one
   * window. Neither consequence is visible from the definition, so both are
   * named at write time rather than discovered when the type grows.
   */
  const records = (id: string) => ({
    id,
    kind: "objects" as const,
    mode: "records" as const,
    objectTypeId: "00000000-0000-4000-8000-000000000000",
  });

  test("column totals on a records table are POLISH — a page sum is not a total", () => {
    const { warnings, polish } = sanitizePageDefinition(
      page(
        {
          grid: {
            type: "table",
            props: { dataset: "deals", totals: ["amount"] },
          },
        },
        { datasets: [records("deals")] },
      ),
    );
    expect(polish.join(" ")).toContain("aggregate dataset");
    expect(warnings).toEqual([]);
  });

  test("a dataset shared by a table and another element is POLISH", () => {
    const { polish } = sanitizePageDefinition(
      page(
        {
          grid: { type: "table", props: { dataset: "deals" } },
          first: { type: "field", props: { dataset: "deals", key: "amount" } },
        },
        { datasets: [records("deals")] },
      ),
    );
    // Paging the table re-queries the dataset, so the KPI beside it would move
    // under the reader.
    expect(polish.join(" ")).toContain("dataset of its own");
  });

  test("a table with its own dataset and no totals raises neither", () => {
    const { warnings, polish } = sanitizePageDefinition(
      page(
        { grid: { type: "table", props: { dataset: "deals" } } },
        { datasets: [records("deals")] },
      ),
    );
    expect(polish).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("totals over an AGGREGATE table stay silent — those rows are the whole answer", () => {
    const { polish } = sanitizePageDefinition(
      page(
        { grid: { type: "table", props: { dataset: "agg", totals: ["nb"] } } },
        {
          datasets: [
            {
              id: "agg",
              kind: "objects",
              mode: "aggregate",
              objectTypeId: "00000000-0000-4000-8000-000000000000",
              groupBy: "month",
              metrics: [{ name: "nb", fn: "count", label: "Count" }],
            },
          ],
        },
      ),
    );
    expect(polish.join(" ")).not.toContain("aggregate dataset");
  });

  test("a row of KPIs with no comparison is POLISH", () => {
    const { warnings, polish } = sanitizePageDefinition(
      page({
        s1: { type: "stat", props: { label: "A", value: 1 } },
        s2: { type: "stat", props: { label: "B", value: 2 } },
      }),
    );
    expect(polish.join(" ")).toContain("comparison");
    expect(warnings).toEqual([]);
  });

  test("one comparison anywhere clears it", () => {
    const { polish } = sanitizePageDefinition(
      page({
        s1: { type: "stat", props: { label: "A", value: 1, compare: 0 } },
        s2: { type: "stat", props: { label: "B", value: 2 } },
      }),
    );
    expect(polish.join(" ")).not.toContain("comparison");
  });

  test("two heroes on one view is a warning", () => {
    const { warnings } = sanitizePageDefinition(
      page({
        s1: {
          type: "stat",
          props: { label: "A", value: 1, emphasis: "hero", compare: 0 },
        },
        s2: {
          type: "stat",
          props: { label: "B", value: 2, emphasis: "hero" },
        },
      }),
    );
    expect(warnings.join(" ")).toContain("hero");
  });
});

describe("theme", () => {
  test("any Tailwind hue is a valid accent", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({}, { theme: { accent: "indigo" } }),
    );
    expect(definition.theme?.accent).toBe("indigo");
    expect(warnings).toEqual([]);
  });

  test("a non-token accent is dropped with a warning", () => {
    const { definition, warnings } = sanitizePageDefinition(
      page({}, { theme: { accent: "cornflower" } }),
    );
    expect(definition.theme?.accent).toBeUndefined();
    expect(warnings.join(" ")).toContain("cornflower");
  });
});

describe("the publish ceilings, warned at WRITE time", () => {
  /** A chain of nested boxes `n` deep, each holding the next. */
  const nested = (depth: number): Record<string, PageElement> => {
    const elements: Record<string, PageElement> = {};
    for (let i = 0; i < depth; i += 1) {
      elements[`box-${i.toString()}`] = {
        type: "box",
        props: {},
        ...(i < depth - 1 ? { children: [`box-${(i + 1).toString()}`] } : {}),
      };
    }
    return elements;
  };

  test("a page nested past the ceiling is warned about before it is saved", () => {
    const deep = nested(PAGE_LIMITS.maxDepth + 4);
    const { warnings } = sanitizePageDefinition({
      version: 2,
      variables: [],
      datasets: [],
      operations: [],
      spec: { root: "box-0", elements: deep },
    });
    // It used to save clean and only fail at publish, with nothing said in the
    // turn that wrote it.
    expect(
      warnings.some((w) => w.includes("nests") && w.includes("publishing")),
    ).toBe(true);
  });

  test("a page within the ceiling says nothing about depth", () => {
    const { warnings } = sanitizePageDefinition({
      version: 2,
      variables: [],
      datasets: [],
      operations: [],
      spec: { root: "box-0", elements: nested(PAGE_LIMITS.maxDepth) },
    });
    expect(warnings.some((w) => w.includes("nests"))).toBe(false);
  });
});

describe("data contract served to the agent", () => {
  const contract = describePageDataContract();

  test("it names every dataset kind the executor can resolve", () => {
    expect(contract).toContain("kind=inline");
    expect(contract).toContain("kind=objects");
    expect(contract).toContain("kind=transform");
  });

  test("it ties datasets and variables to the state paths that read them", () => {
    expect(contract).toContain("/data/<id>");
    expect(contract).toContain("$bindState");
  });

  test("it stays out of the component catalog's territory", () => {
    // Components, props and events come from `@fretik/render` — restating one
    // here is how the two halves start disagreeing.
    expect(contract).not.toContain("chart_bar");
    expect(contract).not.toContain("props:");
  });
});

/**
 * Placement props (`span` / `pad` / `grow`) are ordinary props, but they read
 * as element metadata and the catalog's own worked example wrote them beside
 * `props` for months. An object schema strips unknown keys, so every one of
 * them was deleted before anything could report it — and a 12-column grid then
 * placed the element in a single column.
 */
describe("placement props survive whichever side they are written on", () => {
  const parse = (element: Record<string, unknown>): PageDefinition =>
    PageDefinitionSchema.parse({
      version: 2,
      variables: [],
      datasets: [],
      operations: [],
      spec: {
        root: "root",
        elements: {
          root: { type: "grid", props: { cols: "12" }, children: ["one"] },
          one: element,
        },
      },
    });

  test("a span written beside props lands in props", () => {
    const definition = parse({
      type: "heading",
      props: { text: "Sales" },
      span: "full",
    });
    expect(definition.spec.elements["one"]?.props).toEqual({
      text: "Sales",
      span: "full",
    });
  });

  test("pad and grow travel the same way", () => {
    const definition = parse({ type: "box", pad: "md", grow: true });
    expect(definition.spec.elements["one"]?.props).toEqual({
      pad: "md",
      grow: true,
    });
  });

  test("an explicit prop wins over the sibling form", () => {
    const definition = parse({
      type: "stat",
      props: { label: "X", span: "3" },
      span: "6",
    });
    expect(definition.spec.elements["one"]?.props?.["span"]).toBe("3");
  });

  test("an element with no placement prop is left untouched", () => {
    const definition = parse({ type: "heading", props: { text: "Sales" } });
    expect(definition.spec.elements["one"]).toEqual({
      type: "heading",
      props: { text: "Sales" },
    });
  });
});

/**
 * `data.<id>[0]` over an unordered record list.
 *
 * A record view built this way names whichever row the database happened to
 * return first. Found on a real page whose hero title claimed one customs
 * declaration while its KPI tiles summed every declaration in the workspace —
 * the model said so itself in its closing message, having had no way to say it
 * in the definition.
 */
describe("a binding that reads the first row of an unordered dataset", () => {
  const OBJECT_TYPE_ID = "019f0fd4-7828-7664-a8a2-396b6dc2dbe9";

  const readingFirstRow = (dataset: Record<string, unknown>): PageDefinition =>
    PageDefinitionSchema.parse({
      version: 2,
      variables: [],
      datasets: [dataset],
      spec: {
        root: "title",
        elements: {
          title: {
            type: "heading",
            props: { text: { $: "data.declarations[0].numero_dae" } },
          },
        },
      },
    });

  const records = {
    id: "declarations",
    kind: "objects",
    mode: "records",
    objectTypeId: OBJECT_TYPE_ID,
  };

  test("it is a warning, and it names both ways out", () => {
    const { warnings } = sanitizePageDefinition(readingFirstRow(records));
    const found = warnings.find((w) => w.includes("[0]"));
    expect(found).toBeDefined();
    expect(found).toContain("sortBy");
    expect(found).toContain("filter");
  });

  test("an ordered list says nothing — [0] is then a decision", () => {
    const { warnings } = sanitizePageDefinition(
      readingFirstRow({ ...records, sortBy: "numero_dae" }),
    );
    expect(warnings.some((w) => w.includes("[0]"))).toBe(false);
  });

  test("an aggregate is exempt: [0] is the documented KPI shape", () => {
    // A single-row aggregate has nothing to order, and `data.kpi[0].total` is
    // what the contract tells the agent to write.
    const { warnings } = sanitizePageDefinition(
      readingFirstRow({
        id: "declarations",
        kind: "objects",
        mode: "aggregate",
        objectTypeId: OBJECT_TYPE_ID,
        metrics: [{ name: "n", fn: "count", label: "Declarations" }],
      }),
    );
    expect(warnings.some((w) => w.includes("[0]"))).toBe(false);
  });
});

describe("a twelve-column grid whose children place themselves nowhere", () => {
  const grid = (
    cols: string,
    children: Record<string, PageElement>,
  ): PageDefinition => ({
    version: 2,
    variables: [],
    datasets: [],
    operations: [],
    spec: {
      root: "row",
      elements: {
        row: {
          type: "grid",
          props: { cols },
          children: Object.keys(children),
        },
        ...children,
      },
    },
  });

  const four: Record<string, PageElement> = {
    a: { type: "stat", props: { label: "A", value: 1 } },
    b: { type: "stat", props: { label: "B", value: 2 } },
    c: { type: "stat", props: { label: "C", value: 3 } },
    d: { type: "stat", props: { label: "D", value: 4 } },
  };

  test("it is polish, not a warning — the renderer gives them the full row", () => {
    const { warnings, polish } = sanitizePageDefinition(grid("12", four));
    expect(warnings.some((w) => w.includes("span"))).toBe(false);
    expect(
      polish.some(
        (p) => p.includes('element "row"') && p.includes('span: "3"'),
      ),
    ).toBe(true);
  });

  test("a narrower grid places its children itself and says nothing", () => {
    // `cols: "4"` with four spanless cards is correct — auto-placement is the
    // whole point of the ladder, and only twelve columns never means it.
    const { polish } = sanitizePageDefinition(grid("4", four));
    expect(polish.some((p) => p.includes("no span"))).toBe(false);
  });

  test("children that carry a span say nothing", () => {
    const spanned = Object.fromEntries(
      Object.entries(four).map(([key, element]) => [
        key,
        { ...element, props: { ...element.props, span: "3" } },
      ]),
    );
    const { polish } = sanitizePageDefinition(grid("12", spanned));
    expect(polish.some((p) => p.includes("no span"))).toBe(false);
  });
});
