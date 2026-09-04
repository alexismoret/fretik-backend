import { describe, expect, test } from "bun:test";
import { lintPageDataContract } from "../../src/services/pages/lint";

/**
 * The rule that would have caught the 2026-09-04 build: four dataset configs
 * written in `lib/dealsHelper.ts`, none of them declared, a page that rendered
 * "0 résultat" over 24 records, a gate that passed it and a summary that told
 * the user it worked.
 *
 * The line every case here defends is the one that separates a defect from an
 * ordinary Tuesday: an UNDECLARED dataset is a defect, an EMPTY one is not.
 * A collection nobody has filled yet, an app nobody has connected, a page built
 * the day before the data lands — all of them render an empty state and none of
 * them may be refused. So no assertion below counts a row, and the rule is
 * given no way to.
 */

const page = (files: Record<string, string>) => ({
  source: files["Page.vue"] ?? "<template><div /></template>",
  files: Object.fromEntries(
    Object.entries(files).filter(([path]) => path !== "Page.vue"),
  ),
});

const QUERY = `
import { fretik } from '#fretik/sdk'
export const load = async () => {
  const res = await fretik.data.query({ datasetIds: ['deals'] })
  return res.datasets.deals
}
`;

describe("declared vs used", () => {
  test("a dataset used in code and declared nowhere refuses the build", () => {
    const findings = lintPageDataContract(
      page({ "composables/useData.ts": QUERY }),
      { datasetIds: [], operationIds: [] },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain('"deals"');
  });

  test("the same dataset, declared, is silent — however many rows it returns", () => {
    // The legitimacy case, and the reason this rule reads ids and never rows:
    // an empty collection and a full one are the same page.
    const findings = lintPageDataContract(
      page({ "composables/useData.ts": QUERY }),
      { datasetIds: ["deals"], operationIds: [] },
    );

    expect(findings).toEqual([]);
  });

  test("a dataset config written in code is a declaration in the wrong file", () => {
    // The measured shape: the config lived in a lib module and was passed
    // inline to the bridge, which runs the definition's datasets and nothing
    // else. It reads as configured and behaves as absent.
    const findings = lintPageDataContract(
      page({
        "lib/config.ts": `
export const DATASETS = [
  { id: 'deals', kind: 'collections', collectionId: 'abc', mode: 'records' },
  { id: 'deals_summary', kind: 'collections', collectionId: 'abc', mode: 'aggregate' }
]
`,
      }),
      { datasetIds: [], operationIds: [] },
    );

    expect(findings.map((finding) => finding.rule)).toEqual([
      "undeclared-dataset",
      "undeclared-dataset",
    ]);
    expect(findings.every((finding) => finding.severity === "error")).toBe(
      true,
    );
    expect(findings[0]?.path).toBe("lib/config.ts");
  });

  test("a page that queries nothing and declares nothing is a page", () => {
    // A static page is legal. The rule is about a contradiction, not about
    // whether a page has data.
    const findings = lintPageDataContract(
      page({ "Page.vue": "<template><h1>About</h1></template>" }),
      { datasetIds: [], operationIds: [] },
    );

    expect(findings).toEqual([]);
  });

  test("a query with no ids at all still names the contradiction once", () => {
    const findings = lintPageDataContract(
      page({
        "composables/useData.ts": `
import { fretik } from '#fretik/sdk'
export const load = () => fretik.data.query({})
export const again = () => fretik.data.query({})
`,
      }),
      { datasetIds: [], operationIds: [] },
    );

    // Two calls, one defect: a page that queries in five places is not five
    // times as broken, and five copies of one line is how a fix list gets
    // ignored.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("declares no datasets");
  });

  test("an operation run by id and never declared refuses the build", () => {
    const findings = lintPageDataContract(
      page({
        "composables/useData.ts": `
import { fretik } from '#fretik/sdk'
export const save = () => fretik.ops.run('update_stage', { recordId: '1' })
`,
      }),
      { datasetIds: [], operationIds: [] },
    );

    expect(findings[0]?.rule).toBe("undeclared-operation");
    expect(findings[0]?.message).toContain('"update_stage"');
  });
});

describe("a control that claims a write the page cannot perform", () => {
  const MUTATES = `
import { ref } from 'vue'
import { fretik } from '#fretik/sdk'
const deals = ref([])
const search = ref('')
export const load = async () => {
  const res = await fretik.data.query({ datasetIds: ['deals'] })
  deals.value = res.datasets.deals.rows
}
export const setStage = (idx, stage) => {
  deals.value[idx].stage = stage
}
export const setSearch = (text) => { search.value = text }
`;

  test("writing into loaded rows with no operation declared blocks the review", () => {
    const findings = lintPageDataContract(
      page({ "composables/useData.ts": MUTATES }),
      {
        datasetIds: ["deals"],
        operationIds: [],
      },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("claimed-write");
    // `blocking`, not `error`: the page WORKS, it just tells a lie about one
    // control. Refusing the build would trade a working page for nothing.
    expect(findings[0]?.severity).toBe("blocking");
  });

  test("the same code is silent once the page declares an operation", () => {
    // Whether the RIGHT operation runs is the gate's question — it clicks the
    // control and watches. A lint that guessed at that would fire on every
    // optimistic update.
    const findings = lintPageDataContract(
      page({ "composables/useData.ts": MUTATES }),
      {
        datasetIds: ["deals"],
        operationIds: ["update_stage"],
      },
    );

    expect(findings).toEqual([]);
  });

  test("ordinary local state is not a claimed write", () => {
    // `search.value = text` in the fixture above sets a filter, not a row. If
    // the rule fired on that it would fire on every page ever built.
    const findings = lintPageDataContract(
      page({
        "composables/useData.ts": `
import { ref } from 'vue'
const search = ref('')
const open = ref(false)
export const setSearch = (t) => { search.value = t }
export const toggle = () => { open.value = !open.value }
`,
      }),
      { datasetIds: [], operationIds: [] },
    );

    expect(findings).toEqual([]);
  });
});
