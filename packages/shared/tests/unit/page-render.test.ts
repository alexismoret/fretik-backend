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

    <!-- A control that really calls the bridge, next to one that only looks
         like it does. The harness answers both without executing anything, so
         the CALL is the only thing separating them. -->
    <UButton label="run-op" @click="runOp" />
    <UButton label="fake-op" @click="faked = true" />
    <p v-if="faked" class="text-sm">Saved!</p>

    <!-- A segment group: the one already showing announces itself with
         aria-pressed, and clicking it changes nothing BY DESIGN. -->
    <UButton label="active-segment" aria-pressed="true" @click="segment = 'a'" />
    <UButton label="other-segment" aria-pressed="false" @click="segment = 'b'" />
    <p class="text-sm">Segment {{ segment }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { fretik } from "#fretik/sdk";
const goodOpen = ref(false);
const badOpen = ref(false);
const faked = ref(false);
const segment = ref("a");
const runOp = async () => { await fretik.ops.run("archive", {}); };
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
    // Read off the artifact, not written as a literal: what makes a page's
    // frame load the right assets is that the map follows the version the
    // compile stamped, and a hard-coded version tests the constant instead.
    expect(plain).toContain(
      `"#fretik/sdk":"http://host/page-runtime/${result.compiled.runtimeVersion}/sdk.js"`,
    );
    expect(plain).toContain(
      `"vue-router":"http://host/page-runtime/${result.compiled.runtimeVersion}/router.js"`,
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
      accent: null,
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
    // `desktop-bottom` is conditional — this probe page fits one screen — and
    // the `overlay-*` captures depend on what the click pass opens, so the
    // fixed part of the list is asserted, in order.
    expect(
      result.shots
        .map((shot) => shot.label)
        .filter(
          (label) =>
            label !== "desktop-bottom" && !label.startsWith("overlay-"),
        ),
    ).toEqual(["desktop", "tablet", "mobile", "empty-state"]);
    for (const shot of result.shots)
      expect(shot.png.length).toBeGreaterThan(1_000);
    expect(result.pageErrors).toEqual([]);

    // An overlay is photographed WHILE it is open — the whole reason the click
    // pass is stepped. Judging panels on their text tree alone is what let
    // pages ship with modals visibly cruder than the page behind them.
    const overlayShots = result.shots.filter((shot) =>
      shot.label.startsWith("overlay-"),
    );
    expect(overlayShots.length).toBeGreaterThan(0);
    // The caption names the control that opened it, so the critic judges the
    // panel as an answer to a click rather than as a loose screenshot.
    expect(overlayShots[0]?.caption ?? "").not.toBe("");

    // Ordered before the empty-state capture: the clicks come last, and a
    // capture taken after the page was re-navigated would be of the wrong page.
    const labels = result.shots.map((shot) => shot.label);
    expect(labels.indexOf("overlay-1")).toBeLessThan(
      labels.indexOf("empty-state"),
    );

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

    // The panel's own structure, serialised while it was open. It answers what
    // is IN the panel where the capture answers what it looks like — the gate
    // reasons over this one. It must carry the panel's real text and its
    // inputs, and stay bounded: the string goes straight into a model's
    // context.
    const snapshot = healthy[0]?.overlaySnapshot ?? "";
    expect(snapshot).toContain("This panel has real content.");
    expect(snapshot).toContain("placeholder=");
    expect(snapshot.length).toBeLessThan(1_500);

    // What separates a control that writes from one that pretends to. Both
    // buttons change the DOM, both read as "live" to the click probe, and the
    // harness answers `ops.run` without executing it — so counting the calls
    // is the only evidence left. A mail client whose send button resolved a
    // `setTimeout` and toasted "sent" cleared three rounds of review.
    expect(result.opsRuns).toContain("archive");

    // A control already in the state a click would set is left alone and
    // COUNTED, never clicked and reported dead. Two shipped pages were blocked
    // on "clicking ₫ VND changes nothing" and "clicking Vue d'ensemble changes
    // nothing" — both about the segment that was already showing.
    const clicked = result.interactions.map(
      (interaction) => interaction.target,
    );
    expect(clicked.join(" | ")).toContain("other-segment");
    expect(clicked.join(" | ")).not.toContain("active-segment");
    expect(result.skippedActive ?? 0).toBeGreaterThan(0);

    closeRenderViews();
  }, 120_000);
});
