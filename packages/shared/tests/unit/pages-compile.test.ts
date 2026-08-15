import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import { compilePageCode } from "../../src/services/pages/compile";

/**
 * The server-side SFC compiler — the presentation half's gate. Unlike the data
 * half it REFUSES rather than warns: a module with a syntax error renders
 * NOTHING, so persisting it and warning would report success on a blank
 * screen.
 *
 * The happy-path cases spawn the real Tailwind CLI in a subprocess (a
 * dependency of this package), so they carry their own generous timeout. The
 * refusal cases fail before that step and stay fast.
 */

const TAILWIND_TIMEOUT_MS = 15_000;

const errorsOf = (
  result: Awaited<ReturnType<typeof compilePageCode>>,
): { block: string; message: string }[] => (result.ok ? [] : result.errors);

describe("compilePageCode — a page that builds", () => {
  test(
    'a minimal <script setup lang="ts"> SFC compiles: TS stripped, mount footer added, utilities generated',
    async () => {
      const result = await compilePageCode({
        source: [
          '<template><div class="p-4 text-muted">hi</div></template>',
          '<script setup lang="ts">const n: number = 1\nconsole.log(n)</script>',
        ].join("\n"),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The footer is what makes the module a PAGE: it mounts itself through
      // the sandbox SDK rather than exporting a component someone else wires.
      expect(result.compiled.js).toContain("mountPage");
      // The transpile step removed the annotation — the iframe runs plain JS.
      expect(result.compiled.js).not.toContain(": number");
      // Tailwind scanned the source and emitted the used utility.
      expect(result.compiled.css.length).toBeGreaterThan(0);
      expect(result.compiled.css).toContain("p-4");
      expect(result.compiled.sourceHash).toHaveLength(64);
    },
    TAILWIND_TIMEOUT_MS,
  );

  test(
    "every specifier the srcdoc import map serves is accepted",
    async () => {
      // Mirrors app/utils/pageSrcdoc.ts. The two lists live in different
      // packages, so nothing but this test stops them drifting — and the two
      // failure modes are asymmetric: an allowed-but-unmapped specifier
      // compiles clean and then dies at mount, in front of the user.
      const MAPPED = [
        "vue",
        "@nuxt/ui",
        "chart.js",
        "chart.js/auto",
        "@vueuse/core",
        "@internationalized/date",
        "@atlaskit/pragmatic-drag-and-drop/element/adapter",
        "@atlaskit/pragmatic-drag-and-drop/combine",
        "@atlaskit/pragmatic-drag-and-drop/reorder",
        "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge",
        "#fretik/sdk",
      ];

      const imports = MAPPED.map(
        (specifier, index) => `import * as m${index} from "${specifier}"`,
      ).join("\n");
      const result = await compilePageCode({
        source: [
          "<template><div>ok</div></template>",
          `<script setup lang="ts">${imports}\nconsole.log(${MAPPED.map((_, i) => `m${i}`).join(", ")})</script>`,
        ].join("\n"),
      });

      expect(errorsOf(result)).toEqual([]);
      expect(result.ok).toBe(true);
    },
    TAILWIND_TIMEOUT_MS,
  );

  test(
    "a non-setup <script> with the options API still compiles",
    async () => {
      const result = await compilePageCode({
        source: [
          "<template><div>{{ n }}</div></template>",
          "<script>export default { data: () => ({ n: 1 }) }</script>",
        ].join("\n"),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.compiled.js).toContain("mountPage");
    },
    TAILWIND_TIMEOUT_MS,
  );
});

describe("compilePageCode — refusals, precise enough to fix in one turn", () => {
  test("an import outside the runtime's map is refused by name", async () => {
    const result = await compilePageCode({
      source: [
        "<template><div>x</div></template>",
        '<script setup lang="ts">import _ from "lodash"\nconsole.log(_)</script>',
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    const importError = errorsOf(result).find((e) => e.block === "imports");
    expect(importError).toBeDefined();
    expect(importError?.message).toContain("lodash");
    // The message lists what IS available, so the fix needs no other lookup.
    expect(importError?.message).toContain("#fretik/sdk");
  });

  test("a style reaching outside the sandbox is refused", async () => {
    const result = await compilePageCode({
      source: [
        "<template><div>x</div></template>",
        '<style>@import "x.css";</style>',
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    const styleError = errorsOf(result).find((e) => e.block === "style");
    expect(styleError).toBeDefined();
    expect(styleError?.message).toContain("@import");
  });

  test("a missing template is a structure error — the SFC would render nothing", async () => {
    const result = await compilePageCode({
      source: '<script setup lang="ts">const a = 1\nconsole.log(a)</script>',
    });
    expect(result.ok).toBe(false);
    const structural = errorsOf(result).find((e) => e.block === "structure");
    expect(structural).toBeDefined();
    expect(structural?.message).toContain("<template>");
  });
});
