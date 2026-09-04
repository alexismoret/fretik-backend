# Pattern — workbench: the queue beside the item

A skeleton with REAL wiring. Siblings: `pattern-directory.md` (filter, scan, open, act), `pattern-overview.md` (the figure band), `pattern-detail.md` (one record in full), `pattern-board.md` (drag and drop).

The shape for "work through these": the list stays live on the left while the selected item fills the right. It is what a directory becomes when the reader's job is to get through the rows rather than to find one — and it is the archetype almost no generated page reaches for, because a list plus an overlay is the nearer answer.

## What a finished workbench has

- The selection in a variable, so the URL reopens on the same item and a link is worth sending.
- Keyboard movement: `↑`/`↓` through the queue, `Enter` to act. A queue somebody works for an hour and can only click is a slow queue.
- The item's own actions in the right pane, not in a menu somewhere else.
- A visible count of what is left, and what happens when the queue empties.
- The two panes weighed by the reader (`USplitter`) or fixed by you (a grid) — but never a right pane that collapses to nothing when a long value arrives.

## The frame

```vue
<script setup lang="ts">
import { useTemplateRef } from "vue";
import { onKeyStroke } from "@vueuse/core";
import { fretik } from "#fretik/sdk";
import { useQueue } from "../composables/useQueue";

const { rows, status, reload } = useQueue();
const selectedId = ref<string | null>(
  fretik.context.variables.selected ?? null,
);
const selected = computed(
  () => rows.value.find((row) => row.id === selectedId.value) ?? rows.value[0],
);

const move = (step: number): void => {
  if (rows.value.length === 0) return;
  const at = rows.value.findIndex((row) => row.id === selected.value?.id);
  const next =
    rows.value[Math.min(Math.max(at + step, 0), rows.value.length - 1)];
  if (next) selectedId.value = next.id;
};
onKeyStroke("ArrowDown", (event) => {
  event.preventDefault();
  move(1);
});
onKeyStroke("ArrowUp", (event) => {
  event.preventDefault();
  move(-1);
});

// The selection is a declared variable, so the host mirrors it into the url.
watch(
  selectedId,
  (id) =>
    void fretik.data.query({
      variables: { selected: id ?? "" },
      datasetIds: [],
    }),
);
</script>

<template>
  <div class="flex h-full flex-col gap-4 p-6">
    <header class="flex items-baseline justify-between gap-4">
      <div>
        <h1 class="font-display text-2xl tracking-tight">{{ t.title }}</h1>
        <p class="text-sm text-muted">{{ rows.length }} to work through</p>
      </div>
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        :loading="status === 'loading'"
        @click="reload"
      />
    </header>

    <USplitter
      class="min-h-0 flex-1"
      :items="[
        { slot: 'queue', minSize: 22, defaultSize: 34 },
        { slot: 'item', minSize: 40 },
      ]"
    >
      <template #queue>
        <UEmpty
          v-if="rows.length === 0"
          icon="i-lucide-inbox"
          title="Nothing left"
          description="Everything in this queue has been handled."
        />
        <div v-else class="h-full overflow-y-auto">
          <button
            v-for="row in rows"
            :key="row.id"
            type="button"
            class="flex w-full items-start gap-3 border-b border-default px-3 py-2.5 text-left transition-colors hover:bg-elevated/60"
            :class="row.id === selected?.id ? 'bg-elevated' : ''"
            :aria-current="row.id === selected?.id"
            @click="selectedId = row.id"
          >
            <UBadge
              :label="row.statusLabel"
              :color="row.statusColor"
              variant="subtle"
              size="sm"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{
                row.title
              }}</span>
              <span class="block truncate text-xs text-muted">{{
                row.subtitle
              }}</span>
            </span>
          </button>
        </div>
      </template>

      <template #item>
        <div v-if="selected" class="h-full overflow-y-auto px-5 py-4">
          <!-- The record in full, and its verbs. `pattern-detail.md` is this pane. -->
        </div>
      </template>
    </USplitter>
  </div>
</template>
```

`USplitter` takes its height from its parent, which is why the wrapper carries `min-h-0 flex-1` inside a `flex h-full flex-col` — without `min-h-0` a flex child refuses to shrink below its content and the whole page grows instead of the pane scrolling. `auto-save-id` persists nothing behind the sandbox, so never word the split as remembered.

When the two panes are not the reader's to balance — a fixed 5/7, say — use `grid grid-cols-12` with `col-span-5` and `col-span-7` instead, and keep the same `min-h-0 overflow-y-auto` on each.
