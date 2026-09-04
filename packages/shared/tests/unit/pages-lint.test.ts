import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import {
  findingsOfSeverity,
  lintPageFile,
  lintPageFiles,
  newLintFindings,
} from "../../src/services/pages/lint";

/**
 * The lints, against the shapes that actually shipped.
 *
 * Each case below is a defect a real build produced and every other mechanism
 * missed: the compiler accepted it, the renderer rendered it, and the critic
 * scored it. What is tested is therefore not "the regex matches" but the two
 * properties that make a lint safe to gate on — it FIRES on the measured
 * defect, and it stays SILENT on the legitimate shape it most resembles.
 */

const sfc = (script: string, template = "<div />"): string =>
  [
    "<template>",
    `  ${template}`,
    "</template>",
    '<script setup lang="ts">',
    script,
    "</script>",
  ].join("\n");

describe("native controls", () => {
  test("names every native control and what replaces it", () => {
    // The measured page: 5 `<select>`, no `USelect`; 5 `<table>`, no `UTable`.
    const source = sfc(
      "const x = 1;",
      "<div><select><option>a</option></select><table><tr><td>1</td></tr></table><button>Go</button></div>",
    );
    const findings = lintPageFile("Page.vue", source).filter(
      (finding) => finding.rule === "native-controls",
    );

    expect(findings.map((finding) => finding.message).join(" ")).toContain(
      "USelect",
    );
    expect(findings).toHaveLength(3);
    // Blocking, not error: the page works, so refusing the build would trade a
    // working page for none.
    expect(findings.every((finding) => finding.severity === "blocking")).toBe(
      true,
    );
  });

  test("stays silent on the components that replace them", () => {
    const source = sfc(
      "const x = 1;",
      '<div><USelect :items="[]" /><UTable :data="[]" /><UButton label="Go" /></div>',
    );
    expect(
      lintPageFile("Page.vue", source).filter(
        (finding) => finding.rule === "native-controls",
      ),
    ).toHaveLength(0);
  });

  test("allows the one native control nothing replaces", () => {
    // No component covers a file picker, so `<input type="file">` is the
    // documented shape rather than a slip.
    const source = sfc("const x = 1;", '<input type="file" />');
    expect(
      lintPageFile("Page.vue", source).filter(
        (finding) => finding.rule === "native-controls",
      ),
    ).toHaveLength(0);
  });

  test("points at the line the control is on", () => {
    const source = [
      "<template>",
      "  <div>",
      "    <select><option>a</option></select>",
      "  </div>",
      "</template>",
    ].join("\n");
    const [finding] = lintPageFile("Page.vue", source);
    expect(finding?.line).toBe(3);
  });
});

describe("toggle state", () => {
  test("names the toggle and leaves everything that is not one alone", () => {
    // Both signals are required. A badge whose colour comes from the row's
    // status is the shape this would otherwise flag by the hundred — and it is
    // the doctrine's own advice, a value wearing its colour.
    const source = [
      "<template>",
      "  <UButton :color=\"active ? 'primary' : 'neutral'\" @click=\"active = !active\">Filter</UButton>",
      "  <UBadge :color=\"row.status === 'ok' ? 'success' : 'error'\">{{ row.status }}</UBadge>",
      '  <UButton color="primary" @click="save()">Save</UButton>',
      "</template>",
    ].join("\n");

    const findings = lintPageFile("Page.vue", source).filter(
      (finding) => finding.rule === "toggle-state",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  test("says nothing once the state is declared", () => {
    const source = [
      "<template>",
      '  <UButton :aria-pressed="active" :color="active ? \'primary\' : \'neutral\'" @click="active = !active">Filter</UButton>',
      "</template>",
    ].join("\n");
    expect(
      lintPageFile("Page.vue", source).filter(
        (finding) => finding.rule === "toggle-state",
      ),
    ).toHaveLength(0);
  });
});

describe("fabricated rows", () => {
  test("refuses the shape that shipped 78 invented rows", () => {
    // `populateMockData()` — the Akanea build, over an app the team was never
    // connected to (Langfuse `01a03e9b…`).
    const source = sfc(
      [
        "const rows = ref([]);",
        "const populateMockData = () => {",
        "  rows.value = [",
        '    { id: 1, carrier: "Nord Express", status: "delivered" },',
        '    { id: 2, carrier: "Trans Loire", status: "pending" },',
        "  ];",
        "};",
      ].join("\n"),
    );
    const errors = findingsOfSeverity(
      lintPageFile("Page.vue", source),
      "error",
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.rule).toBe("fabricated-rows");
    expect(errors[0]?.message).toContain("inline");
  });

  test("refuses a catch that fills the page where the query failed", () => {
    const source = sfc(
      [
        "const rows = ref([]);",
        "try {",
        "  const result = await fretik.data.query({});",
        "  rows.value = result.datasets.orders.rows;",
        "} catch (error) {",
        '  rows.value = [{ id: 1, name: "Acme", total: 12 }, { id: 2, name: "Globex", total: 8 }];',
        "}",
      ].join("\n"),
    );
    const errors = findingsOfSeverity(
      lintPageFile("Page.vue", source),
      "error",
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("catch");
  });

  test("refuses a no-rows fallback", () => {
    const source = sfc(
      [
        "const rows = ref([]);",
        "if (rows.value.length === 0) {",
        "  rows.value = [{ id: 1, a: 1 }, { id: 2, a: 2 }];",
        "}",
      ].join("\n"),
    );
    expect(
      findingsOfSeverity(lintPageFile("Page.vue", source), "error"),
    ).toHaveLength(1);
  });

  test("says nothing about an empty state that renders the failure", () => {
    // The correct shape: the status IS the answer.
    const source = sfc(
      [
        "const rows = ref([]);",
        "const failed = ref<string | null>(null);",
        "try {",
        "  const result = await fretik.data.query({});",
        '  if (result.datasets.orders.status === "ok") {',
        "    rows.value = result.datasets.orders.rows;",
        "  } else {",
        "    failed.value = result.datasets.orders.status;",
        "  }",
        "} catch (error) {",
        "  failed.value = String(error);",
        "}",
      ].join("\n"),
    );
    expect(
      findingsOfSeverity(lintPageFile("Page.vue", source), "error"),
    ).toHaveLength(0);
  });

  test("leaves a table's own configuration alone", () => {
    // A column list is not data, and flagging it would teach the agent that
    // this channel is noise.
    const source = sfc(
      [
        "const columns = [",
        '  { accessorKey: "id", header: "Id", sortable: true },',
        '  { accessorKey: "name", header: "Name", sortable: true },',
        '  { accessorKey: "total", header: "Total", sortable: false },',
        '  { accessorKey: "status", header: "Status", sortable: false },',
        '  { accessorKey: "date", header: "Date", sortable: true },',
        '  { accessorKey: "owner", header: "Owner", sortable: false },',
        "];",
      ].join("\n"),
    );
    expect(lintPageFile("Page.vue", source)).toHaveLength(0);
  });

  test("warns — never refuses — on a hand-written table with an honest name", () => {
    const source = sfc(
      [
        "const rows = [",
        '  { id: 1, name: "A", total: 1 },',
        '  { id: 2, name: "B", total: 2 },',
        '  { id: 3, name: "C", total: 3 },',
        '  { id: 4, name: "D", total: 4 },',
        '  { id: 5, name: "E", total: 5 },',
        "];",
      ].join("\n"),
    );
    const findings = lintPageFile("Page.vue", source);
    expect(findingsOfSeverity(findings, "error")).toHaveLength(0);
    expect(findings.some((finding) => finding.rule === "hardcoded-rows")).toBe(
      true,
    );
  });
});

describe("vue pitfalls", () => {
  test("catches `.value` in a template, where a ref is already unwrapped", () => {
    const source = [
      "<template>",
      "  <p>{{ rows.value.length }}</p>",
      "</template>",
      '<script setup lang="ts">',
      "const rows = ref([]);",
      "</script>",
    ].join("\n");
    const findings = lintPageFile("Page.vue", source).filter(
      (finding) => finding.rule === "template-ref-value",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  test("catches an emit nothing declared", () => {
    const source = sfc('const pick = () => emit("select", 1);');
    expect(
      lintPageFile("components/Lane.vue", source).some(
        (finding) => finding.rule === "missing-define-emits",
      ),
    ).toBe(true);
  });

  test("says nothing once it is declared", () => {
    const source = sfc(
      [
        "const emit = defineEmits<{ select: [id: number] }>();",
        'const pick = () => emit("select", 1);',
      ].join("\n"),
    );
    expect(
      lintPageFile("components/Lane.vue", source).some(
        (finding) => finding.rule === "missing-define-emits",
      ),
    ).toBe(false);
  });

  test("catches a composable called inside a hook", () => {
    const source = sfc(
      [
        "onMounted(() => {",
        "  const { rows } = usePageData();",
        "  console.log(rows);",
        "});",
      ].join("\n"),
    );
    const findings = lintPageFile("Page.vue", source).filter(
      (finding) => finding.rule === "composable-scope",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("usePageData");
  });

  test("leaves the runtime's own composables alone", () => {
    // `useToast()` inside a handler is the documented shape.
    const source = sfc(
      ["onMounted(() => {", "  useToast().add({ title: 'hi' });", "});"].join(
        "\n",
      ),
    );
    expect(
      lintPageFile("Page.vue", source).filter(
        (finding) => finding.rule === "composable-scope",
      ),
    ).toHaveLength(0);
  });
});

describe("a project, and the delta of one write", () => {
  test("every file is linted, and each finding names its own", () => {
    const findings = lintPageFiles({
      "Page.vue": sfc("const x = 1;", "<LaneBoard />"),
      "components/LaneBoard.vue": sfc(
        "const x = 1;",
        "<select><option>a</option></select>",
      ),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("components/LaneBoard.vue");
  });

  test("a delta reports what a write introduced, not what it inherited", () => {
    // The whole point: a page carrying five warnings would otherwise report
    // all five on every write, and the line just changed would be invisible.
    const before = lintPageFile(
      "Page.vue",
      sfc("const x = 1;", "<select><option>a</option></select>"),
    );
    const after = lintPageFile(
      "Page.vue",
      sfc(
        "const x = 1;",
        "<div><select><option>a</option></select><button>Go</button></div>",
      ),
    );

    const introduced = newLintFindings(before, after);
    expect(introduced).toHaveLength(1);
    expect(introduced[0]?.message).toContain("<button>");
  });

  test("a fix that shifts a line down does not read as a new finding", () => {
    const before = lintPageFile(
      "Page.vue",
      sfc("const x = 1;", "<select><option>a</option></select>"),
    );
    const after = lintPageFile(
      "Page.vue",
      [
        "<template>",
        "  <div>",
        "    <h1>A heading that was not there before</h1>",
        "    <select><option>a</option></select>",
        "  </div>",
        "</template>",
      ].join("\n"),
    );
    expect(newLintFindings(before, after)).toHaveLength(0);
  });
});

describe("dead handlers", () => {
  /**
   * The shape that shipped on 2026-09-04: `Page.vue` passed `@clear` to a
   * component and defined no `clearFilters`. It compiled, mounted, and the
   * button sat in the empty state doing nothing — the runtime is a production
   * Vue build, so the "not defined on instance" warning does not exist.
   */
  test("fires on an event bound to a name the file never defines", () => {
    const findings = lintPageFile(
      "Page.vue",
      sfc(
        "const rows = [];",
        '<ItemsTable :rows="rows" @clear="clearFilters" />',
      ),
    );
    const dead = findings.filter((f) => f.rule === "dead-handler");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.severity).toBe("error");
    expect(dead[0]?.message).toContain("clearFilters");
  });

  test("stays silent when the handler is defined, however it was declared", () => {
    const script = [
      "import { ref } from 'vue';",
      "const open = ref(false);",
      "function clearFilters() { open.value = false; }",
      "const { reload } = useThing();",
      "const onPick = () => {};",
    ].join("\n");
    const findings = lintPageFile(
      "Page.vue",
      sfc(
        script,
        '<Bar @clear="clearFilters" @reload="reload" @pick="onPick" />',
      ),
    );
    expect(findings.filter((f) => f.rule === "dead-handler")).toEqual([]);
  });

  test("ignores anything that is not a bare identifier", () => {
    // Calls, assignments and `$event` are expressions Vue evaluates in the
    // render scope; only a lone identifier has one legal meaning.
    const findings = lintPageFile(
      "Page.vue",
      sfc(
        "const open = ref(false);",
        '<Bar @a="doThing(row)" @b="open = true" @c="$emit(\'x\')" />',
      ),
    );
    expect(findings.filter((f) => f.rule === "dead-handler")).toEqual([]);
  });
});
