# Pattern — board: columns you can drag between

A skeleton with REAL wiring, not a template to fill in. Siblings: `pattern-directory.md` (filter, scan, open, act), `pattern-overview.md` (the figure band).

**The drag mechanics are `libraries/drag-and-drop.md`, and it is not optional reading** — it holds the registration rule this file's `bind` helper obeys, and getting that wrong is why boards ship looking finished and never move a card. What is here is what makes a BOARD good: lanes that exist at zero, a count per lane, and a move that is written back.

**Drag IS the board's contract when the lane field is writable.** A board over records whose status can be written moves cards by dragging them, wired to the write through a declared operation — shipping the lanes read-only and offering to wire the drag later is shipping half the pattern, and the review treats it as a blocking finding. A `USelectMenu` on the card is an accessibility complement, never the substitute. Read-only lanes are legitimate ONLY when the underlying data truly cannot be written from this page.

Nothing below is a board-specific component: the lanes are a flex row, the cards are yours, and Pragmatic decorates them.

```vue
<template>
  <div class="flex h-full gap-4 overflow-x-auto p-6">
    <section
      v-for="lane in lanes"
      :key="lane.value"
      :ref="(el) => registerLane(el as HTMLElement | null, lane.value)"
      class="flex max-h-full w-72 shrink-0 flex-col rounded-xl border transition-colors"
      :class="
        overLane === lane.value
          ? 'border-primary bg-primary/5'
          : 'border-default'
      "
    >
      <header class="flex items-center gap-2 px-3 py-2.5">
        <span
          class="size-2 rounded-full"
          :style="{
            backgroundColor: `var(--color-${lane.color ?? 'zinc'}-500)`,
          }"
        />
        <h2 class="text-sm font-medium text-highlighted">{{ lane.label }}</h2>
        <span class="ml-auto text-xs text-muted tabular-nums">{{
          lane.cards.length
        }}</span>
      </header>

      <div class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        <article
          v-for="card in lane.cards"
          :key="card.id"
          :ref="(el) => registerCard(el as HTMLElement | null, card)"
          class="cursor-grab rounded-lg border border-default p-3 transition-opacity active:cursor-grabbing"
          :class="draggingId === card.id ? 'opacity-40' : ''"
        >
          <p class="text-sm font-medium text-highlighted">{{ card.title }}</p>
          <p v-if="card.owner" class="mt-1 text-xs text-muted">
            {{ card.owner }}
          </p>
        </article>

        <UEmpty
          v-if="!lane.cards.length"
          icon="i-lucide-inbox"
          :description="`Nothing in ${lane.label}`"
          class="py-6"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { fretik } from "#fretik/sdk";

interface Card {
  id: string;
  title: string;
  owner?: string;
  stage: string;
}

const cards = ref<Card[]>([]);
const draggingId = ref<string | null>(null);
const overLane = ref<string | null>(null);
const toast = useToast();

// Register ONCE per element and do nothing when the node is unchanged. An
// inline `:ref` arrow re-runs on every render with the same node, and these
// handlers cause renders themselves — `libraries/drag-and-drop.md` § the
// registration trap has the measurement and the reason this shape is not
// negotiable.
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
});

const registerCard = (el: HTMLElement | null, card: Card) =>
  bind(`card:${card.id}`, el, (node) =>
    draggable({
      element: node,
      getInitialData: () => ({ cardId: card.id, from: card.stage }),
      onDragStart: () => (draggingId.value = card.id),
      onDrop: () => {
        draggingId.value = null;
        overLane.value = null;
      },
    }),
  );

const registerLane = (el: HTMLElement | null, stage: string) =>
  bind(`lane:${stage}`, el, (node) =>
    combine(
      dropTargetForElements({
        element: node,
        canDrop: ({ source }) => source.data.from !== stage,
        onDragEnter: () => (overLane.value = stage),
        onDragLeave: () => {
          if (overLane.value === stage) overLane.value = null;
        },
        onDrop: ({ source }) => {
          overLane.value = null;
          const id = source.data.cardId;
          if (typeof id === "string") void move(id, stage);
        },
      }),
    ),
  );

// Optimistic: the card lands where it was dropped, and goes back if the
// server refuses. A drop that only *looks* like it worked is a bug.
const move = async (cardId: string, stage: string) => {
  const card = cards.value.find((c) => c.id === cardId);
  if (!card) return;
  const previous = card.stage;
  card.stage = stage;
  const verdict = await fretik.ops.run("set_stage", {
    variables: { cardId, stage },
  });
  if (verdict.status === "ok") return;
  card.stage = previous;
  if (verdict.status !== "cancelled") {
    toast.add({
      title: verdict.message ?? "The card could not be moved",
      color: "error",
    });
  }
};

// Lanes from the FIELD's options, so an empty stage still has a column.
const lanes = computed(() =>
  stageOptions.value.map((o) => ({
    ...o,
    cards: cards.value.filter((c) => c.stage === o.value),
  })),
);
</script>
```

The definition behind it: a `records` dataset for the cards, two variables (`cardId`, `stage`), and the operation the drop calls.

```json
{
  "kind": "record",
  "id": "set_stage",
  "collectionId": "<the cards' type>",
  "mode": "update",
  "recordId": { "var": "cardId" },
  "args": { "stage": { "var": "stage" } }
}
```

This operation can move a card between lanes and can do nothing else. **A board without it does not work** — the lanes render, the drag animates, and the drop silently changes nothing.

Lanes come from the field's `options`, so every stage exists even at zero (`references/data.md`). A lane that appears only when it holds something makes a board that changes shape as people work in it.
