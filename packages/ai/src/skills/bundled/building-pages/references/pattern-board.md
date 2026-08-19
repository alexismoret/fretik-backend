# Pattern — board: columns you can drag between

A skeleton with REAL wiring, not a template to fill in. This is also the reference for drag-and-drop in general. Siblings: `pattern-directory.md` (filter, scan, open, act), `pattern-overview.md` (the figure band).

The Kanban shape, and the reference for drag-and-drop generally. Nothing here is a board-specific component: the lanes are a flex row, the cards are yours, and Pragmatic decorates them. Change the markup freely — a tree, a scheduler and a two-pane picker are the same four calls on different elements.

Lanes come from the field's `options`, so every stage exists even at zero (`references/data.md`), and the move is optimistic with a rollback, because a drop that silently fails is worse than one that refuses.

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

// One cleanup per registered element. Pragmatic returns a teardown from every
// call and a v-for re-registers the same ids, so dropping these leaks
// listeners onto detached nodes.
const cleanups = new Map<string, () => void>();
const bind = (key: string, cleanup: (() => void) | null) => {
  cleanups.get(key)?.();
  if (cleanup) cleanups.set(key, cleanup);
  else cleanups.delete(key);
};
onBeforeUnmount(() => {
  cleanups.forEach((c) => c());
  cleanups.clear();
});

// Ref callbacks fire with the real node on mount and with null on unmount —
// which is exactly the register / unregister pair Pragmatic wants.
const registerCard = (el: HTMLElement | null, card: Card) => {
  if (!el) return bind(`card:${card.id}`, null);
  bind(
    `card:${card.id}`,
    draggable({
      element: el,
      getInitialData: () => ({ cardId: card.id, from: card.stage }),
      onDragStart: () => (draggingId.value = card.id),
      onDrop: () => {
        draggingId.value = null;
        overLane.value = null;
      },
    }),
  );
};

const registerLane = (el: HTMLElement | null, stage: string) => {
  if (!el) return bind(`lane:${stage}`, null);
  bind(
    `lane:${stage}`,
    combine(
      dropTargetForElements({
        element: el,
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
};

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
  "objectTypeId": "<the cards' type>",
  "mode": "update",
  "recordId": { "var": "cardId" },
  "args": { "stage": { "var": "stage" } }
}
```

This operation can move a card between lanes and can do nothing else. **A board without it does not work** — the lanes render, the drag animates, and the drop silently changes nothing.

**For a reorder inside one list** rather than a move between containers, the same two calls apply to the rows, plus `attachClosestEdge` in the drop target's `getData` (so the drop knows whether the pointer was above or below the row it landed on), `extractClosestEdge` on drop, and `reorder({ list, startIndex, finishIndex })` for the array move.
