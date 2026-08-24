import { describe, expect, test } from "bun:test";
// Same side-effect import as page-render.test.ts: `schemas/pages` needs the
// patched Zod before it loads.
import "@hono/zod-openapi";
import type { PageDefinition } from "../../src/schemas/pages";
import { compilePageCode } from "../../src/services/pages/compile";
import { renderPage } from "../../src/services/pages/render/render-page";
import { closeRenderViews } from "../../src/services/pages/render/webview";

/**
 * The drag pass, proven against real Pragmatic boards — one wired the way the
 * reference prescribes, one carrying the exact teardown bug it warns about.
 *
 * This is the validation the gate comment demands before the drop-path
 * signals can be promoted to blocking: the synthetic event sequence the probe
 * fires has to be shown to arm the REAL library end to end, not just its own
 * expectations. The broken board is the shipped failure (measured 2026-08-21:
 * 24 cards draggable at mount, 0 after the first re-render) — the one page
 * shape every earlier gate passed.
 */

/** Two lanes, four cards, the reference's bind helper verbatim. */
const boardSource = (bindImplementation: string): string => `<template>
  <div class="p-6">
    <h1 class="text-xl font-display">Drag probe board</h1>
    <div class="mt-4 grid grid-cols-2 gap-4">
      <section
        v-for="lane in lanes"
        :key="lane"
        :ref="(el) => registerLane(el, lane)"
        class="rounded-lg border p-3"
        :class="overLane === lane ? 'bg-elevated' : ''"
      >
        <p class="text-xs uppercase tracking-wide text-muted">{{ lane }}</p>
        <article
          v-for="card in cardsIn(lane)"
          :key="card.id"
          :ref="(el) => registerCard(el, card)"
          class="mt-2 cursor-grab rounded border p-2 text-sm"
        >
          {{ card.title }}
        </article>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

interface Card { id: string; title: string; lane: string }

const lanes = ["todo", "done"];
const cards = ref<Card[]>([
  { id: "a", title: "Alpha", lane: "todo" },
  { id: "b", title: "Beta", lane: "todo" },
  { id: "c", title: "Gamma", lane: "done" },
  { id: "d", title: "Delta", lane: "done" },
]);
const overLane = ref<string | null>(null);
const cardsIn = (lane: string) => cards.value.filter((card) => card.lane === lane);

${bindImplementation}

const registerCard = (el: unknown, card: Card) =>
  bind("card:" + card.id, el instanceof HTMLElement ? el : null, (node) =>
    draggable({
      element: node,
      getInitialData: () => ({ cardId: card.id, from: card.lane }),
    }),
  );

const registerLane = (el: unknown, lane: string) =>
  bind("lane:" + lane, el instanceof HTMLElement ? el : null, (node) =>
    dropTargetForElements({
      element: node,
      // The re-render trigger: highlighting the hovered lane is what tears a
      // broken board down mid-drag.
      onDragEnter: () => (overLane.value = lane),
      onDragLeave: () => (overLane.value = null),
      onDrop: ({ source }) => {
        overLane.value = null;
        const id = source.data.cardId;
        cards.value = cards.value.map((card) =>
          card.id === id ? { ...card, lane } : card,
        );
      },
    }),
  );
</script>`;

/** The reference's fix: register once per node, do nothing when unchanged. */
const HEALTHY_BIND = `
const bound = new Map<string, { el: HTMLElement; cleanup: () => void }>();
const bind = (
  key: string,
  el: HTMLElement | null,
  register: (el: HTMLElement) => () => void,
) => {
  const previous = bound.get(key);
  if (previous && previous.el === el) return;
  previous?.cleanup();
  bound.delete(key);
  if (!el) return;
  bound.set(key, { el, cleanup: register(el) });
};
onBeforeUnmount(() => {
  bound.forEach((entry) => entry.cleanup());
  bound.clear();
});`;

/**
 * The shipped bug, verbatim from the reference's BROKEN block: the register
 * call is an argument, so it runs before the previous teardown — which then
 * unregisters the same node. Every render ends with the element dead.
 */
const BROKEN_BIND = `
const cleanups = new Map<string, () => void>();
const bind = (
  key: string,
  el: HTMLElement | null,
  register: (el: HTMLElement) => () => void,
) => {
  const cleanup = el ? register(el) : null; // registers FIRST…
  cleanups.get(key)?.(); // …then tears the same node down
  if (cleanup) cleanups.set(key, cleanup);
};
onBeforeUnmount(() => {
  cleanups.forEach((cleanup) => cleanup());
  cleanups.clear();
});`;

const renderBoard = async (bindImplementation: string) => {
  const compiled = await compilePageCode({
    source: boardSource(bindImplementation),
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return null;
  const definition: PageDefinition = {
    version: 3,
    variables: [],
    datasets: [],
    operations: [],
    code: {
      source: boardSource(bindImplementation),
      compiled: compiled.compiled,
    },
  };
  return renderPage({
    compiled: compiled.compiled,
    definition,
    teamId: "00000000-0000-7000-8000-000000000000",
    userId: null,
    pageName: "Drag probe board",
  });
};

describe("page renderer — drag pass", () => {
  test("a board wired per the reference survives the drag and handles the drop", async () => {
    const result = await renderBoard(HEALTHY_BIND);
    if (result === null || result.degraded !== undefined) return;

    expect(result.mounted).toBe(true);
    expect(result.drag).toBeDefined();
    const drag = result.drag;
    if (!drag) return;
    expect(drag.draggablesAtMount).toBe(4);
    expect(drag.draggablesBeforeDrag).toBeGreaterThan(0);
    // The synthetic sequence must arm the REAL library: a live lane prevents
    // the cancelable dragover, and the drop moves the card.
    expect(drag.dragoverAccepted).toBe(true);
    expect(drag.dropHandled).toBe(true);
    expect(drag.domChanged).toBe(true);
    // The whole point: the cards are still draggable after the re-render the
    // drop caused.
    expect(drag.draggablesAfterDrop).toBeGreaterThan(0);
  }, 120_000);

  test("the teardown-bug board collapses to zero draggables — the gate's blocking signature", async () => {
    const result = await renderBoard(BROKEN_BIND);
    if (result === null || result.degraded !== undefined) return;

    expect(result.mounted).toBe(true);
    const drag = result.drag;
    if (!drag) return;
    expect(drag.draggablesAtMount).toBe(4);
    // The drag's own hover highlight re-renders the lane, and that render is
    // what kills every registration. Zero after, permanently.
    expect(drag.domChanged).toBe(true);
    expect(drag.draggablesAfterDrop).toBe(0);

    closeRenderViews();
  }, 120_000);
});
