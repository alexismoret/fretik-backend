import { describe, expect, it } from "bun:test";
import {
  collectDatasets,
  collectNodes,
  definitionText,
  hasNodeMatching,
  nodeTypes,
  pageSource,
  rendersSomething,
} from "../../../evals/cases/page-definition-readers";

/**
 * The pages eval grades the STORED definition, and it has to keep grading it
 * across format migrations — otherwise the baseline it records under one
 * format is not comparable to the score the next one is accepted against.
 *
 * That comparability rests entirely on these readers being blind to the
 * shape. This test pins exactly that, for all three formats: the SAME logical
 * page as the v1 nested `root` tree, the v2 flat `spec.elements` map, and the
 * v3 code page (one Vue SFC), must expose the same facts. v1 and v2 read back
 * identical node types; v3 has no node tree, so `collectNodes` reads the
 * TEMPLATE's component tags instead and the chart/prose intents are probed on
 * `pageSource`. If someone tightens a reader to one shape, the suite silently
 * stops measuring the others and this test fails first.
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

/**
 * The same page in the code shape (v3): heading, chart and table are now an
 * SFC. The script deliberately contains PascalCase (`Chart`, the generic
 * `ref<HTMLCanvasElement>`) that a whole-source scan would miscount as
 * components — the tag scan must stay inside the template.
 */
const CODE_SOURCE = `<template>
  <div class="space-y-6 p-6">
    <h1 class="text-2xl font-display">Pipeline</h1>
    <UCard variant="soft">
      <USkeleton v-if="pending" class="h-64" />
      <canvas v-show="!pending" ref="stageCanvas" />
    </UCard>
    <UCard variant="soft">
      <UEmpty v-if="rows.length === 0" title="No deals" />
      <UTable v-else :data="rows">
        <template #stage-cell="{ row }">
          <UBadge>{{ row.original.stage }}</UBadge>
        </template>
      </UTable>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Chart from 'chart.js/auto'
import { fretik } from '#fretik/sdk'

const pending = ref(true)
const rows = ref<Record<string, unknown>[]>([])
const stageCanvas = ref<HTMLCanvasElement | null>(null)

onMounted(async () => {
  const { datasets } = await fretik.data.query({ variables: { stage: '' } })
  if (datasets.deals?.status === 'ok') rows.value = datasets.deals.rows
  pending.value = false
})
</script>
`;

const CODE_DEFINITION = {
  version: 3,
  variables: [{ key: "stage", type: "string" }],
  datasets: NESTED_DEFINITION.datasets,
  operations: [],
  code: { source: CODE_SOURCE },
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

describe("pages eval — code shape (v3) readers", () => {
  it("reads the template's component tags as pseudo-nodes, one per occurrence", () => {
    expect(nodeTypes(CODE_DEFINITION).sort()).toEqual([
      "UBadge",
      "UCard",
      "UCard",
      "UEmpty",
      "USkeleton",
      "UTable",
      "canvas",
    ]);
  });

  it("scans the TEMPLATE only — script PascalCase is not a component", () => {
    const types = nodeTypes(CODE_DEFINITION);
    // `import Chart from 'chart.js/auto'` and `ref<HTMLCanvasElement>` live in
    // the script; counting them would fabricate nodes.
    expect(types).not.toContain("Chart");
    expect(types).not.toContain("HTMLCanvasElement");
    expect(types).not.toContain("Record");
  });

  it("falls back to scanning the whole source when there is no <template>", () => {
    const bare = { version: 3, code: { source: '<UAlert title="hi" />' } };
    expect(nodeTypes(bare)).toEqual(["UAlert"]);
  });

  it("keeps the shared probes working through the tag scan", () => {
    // `pageSaved(n)` counts these pseudo-nodes; /table/i must see <UTable>.
    expect(collectNodes(CODE_DEFINITION).length).toBeGreaterThanOrEqual(5);
    expect(hasNodeMatching(CODE_DEFINITION, /table/i)).toBe(true);
    expect(hasNodeMatching(CODE_DEFINITION, /canvas/)).toBe(true);
    // …and the historical chart-NODE probe does NOT fire: a code page charts
    // via chart.js on a <canvas>, which is exactly why the suite probes the
    // SOURCE (`/chart\.js|<canvas/i`), never node types, for charts now.
    expect(hasNodeMatching(CODE_DEFINITION, /chart/i)).toBe(false);
  });

  it("exposes the SFC through pageSource, and only on code shapes", () => {
    expect(pageSource(CODE_DEFINITION)).toContain("Pipeline");
    expect(pageSource(NESTED_DEFINITION)).toBe("");
    expect(pageSource(FLAT_DEFINITION)).toBe("");
    for (const bad of [null, undefined, 42, "nope", [], {}]) {
      expect(pageSource(bad)).toBe("");
    }
  });

  it("reads 'would this draw anything' off the source", () => {
    expect(rendersSomething(CODE_DEFINITION)).toBe(true);
    // The blank-page save: a code shape with nothing authored draws nothing.
    expect(rendersSomething({ version: 3, code: { source: "" } })).toBe(false);
    expect(rendersSomething({ version: 3, code: { source: "  \n " } })).toBe(
      false,
    );
    expect(rendersSomething({ version: 3, code: {} })).toBe(false);
  });

  it("reads datasets and reference probes exactly like the other shapes", () => {
    expect(collectDatasets(CODE_DEFINITION)).toHaveLength(2);
    // definitionText serialises `code.source`, so text probes (field keys,
    // chart.js, bridge calls) see the authored code too.
    expect(definitionText(CODE_DEFINITION)).toContain("type-1");
    expect(definitionText(CODE_DEFINITION)).toContain("chart.js");
    expect(definitionText(CODE_DEFINITION)).toContain("fretik.data.query");
  });
});
