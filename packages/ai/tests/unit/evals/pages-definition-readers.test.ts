import { describe, expect, it } from "bun:test";
import {
  collectDatasets,
  collectNodes,
  definitionText,
  hasNodeMatching,
  nodeTypes,
  rendersSomething,
} from "../../../evals/cases/page-definition-readers";

/**
 * The pages eval grades the STORED definition, and it has to keep grading it
 * across the json-render refonte — otherwise the baseline it records today is
 * not comparable to the score the migration is accepted against.
 *
 * That comparability rests entirely on these readers being blind to the tree
 * shape. This test pins exactly that: the SAME logical page, expressed as the
 * current nested `root` tree and as the flat `spec.elements` map that replaces
 * it, must read back identically. If someone tightens a reader to one shape,
 * the suite silently stops measuring the other and this test fails first.
 */

/** The reference page: a heading, a chart, and a table with a cell subtree. */
const NESTED_DEFINITION = {
  version: 1,
  variables: [{ key: "stage", type: "string" }],
  datasets: [
    { id: "deals", kind: "objects", objectTypeId: "type-1", mode: "records" },
    {
      id: "by_stage",
      kind: "objects",
      objectTypeId: "type-1",
      mode: "aggregate",
    },
  ],
  root: [
    {
      id: "section",
      type: "section",
      children: [
        { id: "title", type: "heading", props: { text: "Pipeline" } },
        {
          id: "chart",
          type: "chart_bar",
          props: { dataset: "by_stage", x: "group", y: "n" },
        },
        {
          id: "table",
          type: "table",
          props: { dataset: "deals" },
          cells: [{ id: "cell", type: "badge", props: { label: "x" } }],
        },
      ],
    },
  ],
};

/** The same page in the flat shape (`children` become key references). */
const FLAT_DEFINITION = {
  version: 2,
  datasets: NESTED_DEFINITION.datasets,
  spec: {
    root: "section",
    state: { stage: "" },
    elements: {
      section: {
        type: "section",
        props: {},
        children: ["title", "chart", "table"],
      },
      title: { type: "heading", props: { text: "Pipeline" }, children: [] },
      chart: {
        type: "chart_bar",
        props: { dataset: "by_stage", x: "group", y: "n" },
        children: [],
      },
      table: { type: "table", props: { dataset: "deals" }, children: ["cell"] },
      cell: { type: "badge", props: { label: "x" }, children: [] },
    },
  },
};

describe("pages eval — format-agnostic definition readers", () => {
  it("reads the same node types from the nested and the flat shape", () => {
    const nested = nodeTypes(NESTED_DEFINITION).sort();
    const flat = nodeTypes(FLAT_DEFINITION).sort();
    expect(nested).toEqual([
      "badge",
      "chart_bar",
      "heading",
      "section",
      "table",
    ]);
    expect(flat).toEqual(nested);
  });

  it("descends into children AND table cell subtrees on the nested shape", () => {
    // `cells` is a separate branch from `children` — a reader that forgets it
    // under-counts every table page.
    expect(nodeTypes(NESTED_DEFINITION)).toContain("badge");
    expect(collectNodes(NESTED_DEFINITION)).toHaveLength(5);
  });

  it("reads datasets identically in both shapes", () => {
    expect(collectDatasets(NESTED_DEFINITION)).toHaveLength(2);
    expect(collectDatasets(FLAT_DEFINITION)).toHaveLength(2);
  });

  it("returns empty instead of throwing on absent or malformed input", () => {
    for (const bad of [null, undefined, 42, "nope", [], {}]) {
      expect(collectNodes(bad)).toEqual([]);
      expect(collectDatasets(bad)).toEqual([]);
      expect(nodeTypes(bad)).toEqual([]);
    }
  });

  it("ignores tree entries that are not nodes", () => {
    expect(
      nodeTypes({ root: [null, "text", { id: "x" }, { type: 7 }] }),
    ).toEqual([]);
  });

  it("matches node types by pattern in both shapes", () => {
    for (const def of [NESTED_DEFINITION, FLAT_DEFINITION]) {
      expect(hasNodeMatching(def, /chart/i)).toBe(true);
      expect(hasNodeMatching(def, /table/i)).toBe(true);
      expect(hasNodeMatching(def, /^stat$/i)).toBe(false);
    }
  });

  it("reads 'would this draw anything' identically in both shapes", () => {
    expect(rendersSomething(NESTED_DEFINITION)).toBe(true);
    expect(rendersSomething(FLAT_DEFINITION)).toBe(true);
  });

  it("reports a page that draws nothing, whichever shape hides it", () => {
    // The prod failure: datasets present, elements empty, root dangling.
    expect(
      rendersSomething({ version: 2, spec: { root: "root", elements: {} } }),
    ).toBe(false);
    expect(
      rendersSomething({
        version: 2,
        spec: { root: "main", elements: { header: { type: "heading" } } },
      }),
    ).toBe(false);
    expect(rendersSomething({ version: 1, root: [] })).toBe(false);
    for (const bad of [null, undefined, 42, "nope", []]) {
      expect(rendersSomething(bad)).toBe(false);
    }
  });

  it("serialises the whole definition for reference probes", () => {
    // The state / field-key / object-type-id assertions all run through this,
    // so it must reach references wherever the shape buries them.
    expect(definitionText(NESTED_DEFINITION)).toContain("type-1");
    expect(definitionText(FLAT_DEFINITION)).toContain("type-1");
    expect(definitionText(FLAT_DEFINITION)).toContain("stage");
    expect(definitionText(undefined)).toBe("{}");
  });
});
