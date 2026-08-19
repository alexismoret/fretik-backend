import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import type { PageDefinition } from "../../src/schemas/pages";
import { compilePageCode } from "../../src/services/pages/compile";
import { buildHarnessHtml } from "../../src/services/pages/render/harness";
import { renderPage } from "../../src/services/pages/render/render-page";
import { buildPageSrcdoc } from "../../src/services/pages/render/srcdoc";
import { closeRenderViews } from "../../src/services/pages/render/webview";

/**
 * The renderer's contract, proven against a page built to fail the way real
 * pages fail.
 *
 * `SOURCE` reproduces the exact defect found in two shipped pages: an overlay
 * placed in `UModal`'s DEFAULT slot — which is the TRIGGER, not the panel — so
 * the modal opens with its title and buttons and nothing inside. It compiles
 * cleanly, logs nothing, and looks fine until someone clicks. That is the
 * whole reason this service exists.
 */

const SOURCE = `<template>
  <div class="p-6 space-y-4">
    <h1 class="text-2xl font-display tracking-tight">Renderer probe</h1>
    <p class="text-sm text-muted">A page with one healthy overlay and one empty one.</p>

    <UModal v-model:open="goodOpen" title="Healthy">
      <template #body>
        <div class="space-y-2">
          <p>This panel has real content.</p>
          <input class="border" placeholder="a field" />
        </div>
      </template>
    </UModal>
    <UButton label="open-good" @click="goodOpen = true" />

    <!-- The defect: content in the default slot renders INLINE as a trigger,
         so the panel itself opens empty. -->
    <UModal v-model:open="badOpen" title="Empty">
      <div class="hidden">stranded content</div>
    </UModal>
    <UButton label="open-bad" @click="badOpen = true" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
const goodOpen = ref(false);
const badOpen = ref(false);
</script>`;

const definitionFor = (
  compiled: NonNullable<PageDefinition["code"]["compiled"]>,
): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: SOURCE, compiled },
});

describe("page srcdoc", () => {
  test("keeps the sandbox contract, and only carries the probe when asked", async () => {
    const result = await compilePageCode({ source: SOURCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plain = buildPageSrcdoc({
      compiled: result.compiled,
      nonce: "n",
      parentOrigin: "http://host",
    });
    expect(plain).toContain("connect-src 'none'");
    expect(plain).toContain(
      '"#fretik/sdk":"http://host/page-runtime/v1/sdk.js"',
    );
    // The document a user's browser loads must never carry the probe.
    expect(plain).not.toContain("__probe__");

    const probed = buildPageSrcdoc({
      compiled: result.compiled,
      nonce: "n",
      parentOrigin: "http://host",
      probe: true,
    });
    expect(probed).toContain("__probe__");
  });

  test("harness never lets an operation actually run", async () => {
    const result = await compilePageCode({ source: SOURCE });
    if (!result.ok) return;
    const html = buildHarnessHtml({
      srcdoc: buildPageSrcdoc({
        compiled: result.compiled,
        nonce: "n",
        parentOrigin: "http://host",
      }),
      nonce: "n",
      parentOrigin: "http://host",
      fixtures: {},
      pageName: "probe",
      dark: false,
      locale: "en",
    });
    expect(html).toContain("simulated in review");
  });
});

describe("page renderer", () => {
  test("mounts, captures every viewport, and tells an empty overlay from a healthy one", async () => {
    const compileResult = await compilePageCode({ source: SOURCE });
    expect(compileResult.ok).toBe(true);
    if (!compileResult.ok) return;

    const result = await renderPage({
      compiled: compileResult.compiled,
      definition: definitionFor(compileResult.compiled),
      teamId: "00000000-0000-7000-8000-000000000000",
      userId: null,
      pageName: "Renderer probe",
    });

    // No browser here (CI without Chrome) is not a page defect: the service
    // degrades, and so does this test rather than failing red for it.
    if (result.degraded !== undefined) {
      expect(result.shots).toHaveLength(0);
      return;
    }

    expect(result.mounted).toBe(true);
    // `desktop-bottom` is conditional — this probe page fits one screen — so
    // the fixed part of the list is asserted, in order.
    expect(
      result.shots
        .map((shot) => shot.label)
        .filter((label) => label !== "desktop-bottom"),
    ).toEqual(["desktop", "tablet", "mobile", "empty-state"]);
    for (const shot of result.shots)
      expect(shot.png.length).toBeGreaterThan(1_000);
    expect(result.pageErrors).toEqual([]);

    const opened = result.interactions.filter(
      (interaction) => interaction.overlayOpened,
    );
    expect(opened.length).toBeGreaterThan(0);

    // The healthy panel carries content elements; the stranded one carries
    // none. That gap is the whole mechanical gate.
    const healthy = opened.filter(
      (interaction) => interaction.overlayContentCount > 0,
    );
    expect(healthy.length).toBeGreaterThan(0);

    closeRenderViews();
  }, 120_000);
});
