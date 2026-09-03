import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `common/params`, which calls `.openapi()` — patched
// into Zod by this import, and only by it.
import "@hono/zod-openapi";
import type { PageDefinition } from "../../src/schemas/pages";
import { compilePageCode } from "../../src/services/pages/compile";
import { renderPage } from "../../src/services/pages/render/render-page";
import { closeRenderViews } from "../../src/services/pages/render/webview";

/**
 * A page as a small Vue PROJECT — an entry, components, a composable, a helper.
 *
 * It exists because of what one file costs to change: measured over two
 * production builds (2026-08-28), a fix touching 7% of the lines re-emitted the
 * whole 25 000-token SFC, three times over. The unit of rewrite has to be a
 * file somebody can rewrite cheaply.
 *
 * Two claims are load-bearing here and neither can be read off the source:
 * `components/KpiStrip.vue` is usable as `<KpiStrip>` with NO import anywhere in
 * the page, and Tailwind sees the classes of every file, not just the entry's.
 */

const ENTRY = `<template>
  <div class="p-6 space-y-4">
    <h1 class="text-2xl font-display tracking-tight">{{ title }}</h1>
    <KpiStrip :rows="rows" />
    <LaneBoard :rows="rows" @pick="title = $event" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRows } from "./composables/useRows";
const title = ref("Cockpit");
const { rows } = useRows();
</script>`;

const FILES: Record<string, string> = {
  // Uses a lib helper by relative import, and is used by BOTH other templates.
  "components/KpiStrip.vue": `<template>
  <div class="flex gap-3">
    <UCard v-for="row in rows" :key="row.id" class="p-2">
      <span class="kpi-total">{{ format(row.total) }}</span>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { format } from "../lib/format";
defineProps<{ rows: { id: string; total: number }[] }>();
</script>`,
  // Uses another component of the project, with no import of its own.
  "components/LaneBoard.vue": `<template>
  <div class="mt-4 grid grid-cols-3 gap-2">
    <KpiStrip :rows="rows" />
    <UButton v-for="row in rows" :key="row.id" @click="emit('pick', row.id)">
      {{ row.id }}
    </UButton>
  </div>
</template>

<script setup lang="ts">
defineProps<{ rows: { id: string; total: number }[] }>();
const emit = defineEmits<{ pick: [id: string] }>();
</script>`,
  "composables/useRows.ts": `import { ref } from "vue";

export const useRows = () => {
  const rows = ref([
    { id: "lane-a", total: 1240 },
    { id: "lane-b", total: 86 },
  ]);
  return { rows };
};`,
  "lib/format.ts": `export const format = (value: number): string =>
  new Intl.NumberFormat("fr-FR").format(value);`,
};

const definitionFor = (
  compiled: NonNullable<PageDefinition["code"]["compiled"]>,
): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: ENTRY, files: FILES, compiled },
});

describe("compilePageCode — a project of several files", () => {
  test("links the files into one module and scans them all for Tailwind", async () => {
    const result = await compilePageCode({ source: ENTRY, files: FILES });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    // One module: the iframe loads exactly one, and every relative import is
    // resolved inside it. What is left importable is what the import map serves.
    expect(result.compiled.js).not.toContain("./composables/useRows");
    expect(result.compiled.js).toContain('from "#fretik/sdk"');
    // `grid-cols-3` exists ONLY in components/LaneBoard.vue. A Tailwind pass
    // that scanned the entry alone would render that board unstyled.
    expect(result.compiled.css).toContain("grid-cols-3");
    // Nothing about the machine that built it: the scratch path Bun labels
    // each module with is cut back to the project path.
    expect(result.compiled.js).not.toContain("/tmp/");
    expect(result.compiled.js).toContain("// components/KpiStrip.vue.js");
  });

  test("the same project compiles to the same hash, a renamed file to another", async () => {
    const first = await compilePageCode({ source: ENTRY, files: FILES });
    const again = await compilePageCode({ source: ENTRY, files: FILES });
    const { "composables/useRows.ts": composable, ...others } = FILES;
    const renamed = await compilePageCode({
      source: ENTRY.replace("./composables/useRows", "./composables/useLanes"),
      files: { ...others, "composables/useLanes.ts": composable ?? "" },
    });
    if (!first.ok || !again.ok || !renamed.ok) {
      throw new Error(
        JSON.stringify(
          [first, again, renamed]
            .filter((result) => !result.ok)
            .flatMap((result) => (result.ok ? [] : result.errors)),
        ),
      );
    }

    expect(again.compiled.sourceHash).toBe(first.compiled.sourceHash);
    expect(renamed.compiled.sourceHash).not.toBe(first.compiled.sourceHash);
  });

  test("names the file an error is in, not just the line", async () => {
    const result = await compilePageCode({
      source: ENTRY,
      files: {
        ...FILES,
        "components/KpiStrip.vue": "<template><div></template>",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.file).toBe("components/KpiStrip.vue");
  });

  test("a relative import to a file the page does not have names the ones it has", async () => {
    const result = await compilePageCode({
      source: ENTRY.replace("./composables/useRows", "./composables/useOrders"),
      files: FILES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.map((error) => error.message).join(" ");
    expect(message).toContain("composables/useOrders.ts");
    expect(message).toContain("composables/useRows.ts");
  });

  test("a one-file page still compiles with no bundler in the way", async () => {
    const result = await compilePageCode({
      source: `<template><div class="p-6">alone</div></template>`,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    // The compiled SFC itself, not a bundle: no module banner, no re-export.
    expect(result.compiled.js).not.toContain("// Page.vue.js");
    expect(result.compiled.js).toContain("__fretikMountPage");
  });
});

describe("a project in a real browser", () => {
  test("resolves every component by name, with no import anywhere", async () => {
    const compileResult = await compilePageCode({
      source: ENTRY,
      files: FILES,
    });
    if (!compileResult.ok)
      throw new Error(JSON.stringify(compileResult.errors));

    const result = await renderPage({
      compiled: compileResult.compiled,
      definition: definitionFor(compileResult.compiled),
      teamId: "00000000-0000-7000-8000-000000000000",
      userId: null,
      pageName: "Project probe",
    });

    // No browser here (CI without Chrome) is not a page defect.
    if (result.degraded !== undefined) {
      expect(result.shots).toHaveLength(0);
      return;
    }

    expect(result.mounted).toBe(true);
    // Vue warns rather than throws on an unresolved component, so a registry
    // that failed would show up here and nowhere else.
    expect(result.consoleErrors.join(" ")).not.toContain("resolve component");
    expect(result.pageErrors).toEqual([]);
    // `KpiStrip` renders inside `LaneBoard`, which the entry never imports —
    // one component reaching another through the registry alone.
    expect(result.layout["desktop"]?.textLength ?? 0).toBeGreaterThan(0);
    const clicked = result.interactions.map(
      (interaction) => interaction.target,
    );
    expect(clicked.join(" | ")).toContain("lane-a");

    closeRenderViews();
  }, 120_000);
});
