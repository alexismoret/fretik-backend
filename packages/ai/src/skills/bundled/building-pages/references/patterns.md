# Page patterns

Complete pages and the wiring that is easy to get wrong. Read the one whose shape matches the request, then change everything that should differ — these are skeletons with real wiring, not templates to fill in.

## Directory — filter, scan, open, act

The most common page: a segmented, searchable list of records where clicking a row opens the full item and one action can be taken on it. Note what it does beyond rendering rows — segment counts, real cells, detail on demand, server-side paging, all four dataset states.

```vue
<template>
  <div class="flex h-full flex-col gap-4 p-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="font-display text-2xl tracking-tight">Deals</h1>
        <p class="text-sm text-muted">
          Everything open, by stage. Updated on each visit.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search a company…"
          class="w-64"
        />
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          :loading="pending"
          @click="load()"
        />
      </div>
    </div>

    <div class="flex flex-wrap gap-2">
      <UButton
        v-for="segment in segments"
        :key="segment.value"
        size="xs"
        :color="segment.value === stage ? 'primary' : 'neutral'"
        :variant="segment.value === stage ? 'soft' : 'ghost'"
        @click="stage = segment.value"
      >
        {{ segment.label }}
        <UBadge
          :label="String(segment.count)"
          size="sm"
          variant="subtle"
          color="neutral"
        />
      </UButton>
    </div>

    <UAlert
      v-if="failure"
      icon="i-lucide-triangle-alert"
      color="error"
      variant="soft"
      title="This list could not be loaded"
      :description="failure"
    />

    <div v-else-if="pending" class="space-y-2">
      <USkeleton v-for="i in 6" :key="i" class="h-12 w-full" />
    </div>

    <UEmpty
      v-else-if="rows.length === 0"
      icon="i-lucide-inbox"
      title="No deal at this stage"
      description="Pick another stage, or clear the search."
    />

    <template v-else>
      <!-- Bounded region + pinned header: the column names must survive scrolling,
           and the page must not grow without limit as rows arrive. -->
      <div
        class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-default"
      >
        <UTable
          :data="rows"
          :columns="columns"
          sticky
          :ui="{ tr: 'cursor-pointer hover:bg-elevated/50' }"
          @select="(row) => (selected = row.original)"
        >
          <template #company-cell="{ row }">
            <span class="font-medium text-highlighted">{{
              row.original.company
            }}</span>
          </template>
          <!-- the value's own colour and icon, from the field's options -->
          <template #stage-cell="{ row }">
            <span
              class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
              :style="chip(option('stage', row.original.stage)?.color)"
            >
              <UIcon
                v-if="option('stage', row.original.stage)?.icon"
                :name="`i-lucide-${option('stage', row.original.stage).icon}`"
                class="size-3.5"
              />
              {{ label("stage", row.original.stage) }}
            </span>
          </template>
          <template #owner-cell="{ row }">
            <UUser :name="row.original.ownerName" size="sm" />
          </template>
          <template #amount-cell="{ row }">
            <span class="tabular-nums">{{ money(row.original.amount) }}</span>
          </template>
          <template #actions-cell="{ row }">
            <UButton
              size="xs"
              variant="soft"
              :loading="closingId === row.original.id"
              @click.stop="closeDeal(row.original)"
            >
              Mark won
            </UButton>
          </template>
        </UTable>
      </div>

      <div class="flex items-center justify-between">
        <p class="text-xs text-muted tabular-nums">{{ total }} deals</p>
        <UPagination
          v-model:page="page"
          :total="total"
          :items-per-page="pageSize"
        />
      </div>
    </template>

    <USlideover
      v-model:open="detailOpen"
      :title="selected?.company"
      :description="label('stage', selected?.stage)"
    >
      <template #body>
        <dl v-if="selected" class="space-y-4">
          <div v-for="field in detailFields" :key="field.key">
            <dt class="text-xs uppercase tracking-wide text-muted">
              {{ field.label }}
            </dt>
            <dd class="mt-1 text-sm text-highlighted">
              {{ display(field.key, selected[field.key]) }}
            </dd>
          </div>
        </dl>
      </template>
    </USlideover>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fretik, type DatasetResult } from "#fretik/sdk";

const pending = ref(true);
const stage = ref("");
const search = ref("");
const page = ref(1);
const pageSize = 25;
const closingId = ref<string | null>(null);
const selected = ref<Record<string, any> | null>(null);
const datasets = ref<Record<string, DatasetResult>>({});
const toast = useToast();

const detailOpen = computed({
  get: () => selected.value !== null,
  set: (open: boolean) => {
    if (!open) selected.value = null;
  },
});

const load = async (ids?: string[]) => {
  pending.value = true;
  const result = await fretik.data.query({
    variables: { stage: stage.value, search: search.value },
    queries: {
      deals: { page: page.value, pageSize, sortBy: "amount", sortDir: "desc" },
    },
    ...(ids ? { datasetIds: ids } : {}),
  });
  datasets.value = { ...datasets.value, ...result.datasets };
  pending.value = false;
};

onMounted(() => load());
watch([stage, page], () => load());
watch(search, () => {
  page.value = 1;
  void load();
});

const deals = computed(() => datasets.value.deals);
const rows = computed(() =>
  deals.value?.status === "ok"
    ? (deals.value.rows as Record<string, any>[])
    : [],
);
const total = computed(() =>
  deals.value?.status === "ok"
    ? (deals.value.totalCount ?? rows.value.length)
    : 0,
);
const failure = computed(() =>
  deals.value?.status === "error"
    ? deals.value.message
    : deals.value?.status === "forbidden"
      ? "You do not have access to these records."
      : null,
);

// `fields` is the display dictionary — see references/data.md
const meta = computed(() =>
  Object.fromEntries(
    ((deals.value?.status === "ok" && deals.value.fields) || []).map((f) => [
      f.key,
      f,
    ]),
  ),
);
const option = (key: string, value: unknown) =>
  meta.value[key]?.options?.find((o) => o.value === value);
const label = (key: string, value: unknown) =>
  value ? (option(key, value)?.label ?? String(value)) : "—";
const chip = (color?: string | null) => {
  const base = `var(--color-${color ?? "zinc"}-500)`;
  return {
    color: base,
    backgroundColor: `color-mix(in oklab, ${base} 14%, transparent)`,
  };
};
const money = (value: unknown) => {
  const v = value as { amount: number; currencyCode?: string } | null;
  return v
    ? new Intl.NumberFormat(fretik.context.locale, {
        style: "currency",
        currency: v.currencyCode ?? "EUR",
      }).format(v.amount)
    : "—";
};
const display = (key: string, value: unknown) =>
  meta.value[key]?.type === "money" ? money(value) : label(key, value);

const detailFields = computed(() =>
  Object.values(meta.value).filter((f) => f.key !== "id"),
);

// Segments come from the FIELD's options, not from the rows that exist today:
// every stage is offered, the empty ones at zero, so the control does not
// reshape itself as records move through the pipeline.
const segments = computed(() => {
  const counts = datasets.value.byStage;
  const tally = new Map(
    counts?.status === "ok"
      ? (counts.rows as { stage: string; count: number }[]).map((r) => [
          r.stage,
          r.count,
        ])
      : [],
  );
  const options = meta.value.stage?.options ?? [];
  return [
    {
      value: "",
      label: "All",
      count: [...tally.values()].reduce((a, b) => a + b, 0),
    },
    ...options.map((o) => ({
      value: o.value,
      label: o.label,
      color: o.color,
      count: tally.get(o.value) ?? 0,
    })),
  ];
});

const columns = computed(() => [
  { accessorKey: "company", header: meta.value.company?.label ?? "Company" },
  { accessorKey: "stage", header: meta.value.stage?.label ?? "Stage" },
  { accessorKey: "owner", header: "Owner" },
  { accessorKey: "amount", header: meta.value.amount?.label ?? "Amount" },
  { id: "actions", header: "" },
]);

const closeDeal = async (deal: Record<string, any>) => {
  closingId.value = deal.id;
  const verdict = await fretik.ops.run("close_deal", {
    variables: { dealId: deal.id },
  });
  closingId.value = null;
  if (verdict.status === "ok") {
    toast.add({ title: `${deal.company} marked won`, color: "success" });
    await load(["deals", "byStage"]);
  } else if (verdict.status !== "cancelled") {
    toast.add({
      title: verdict.message ?? "The action failed",
      color: "error",
    });
  }
};
</script>
```

The definition behind it: a `records` dataset `deals` filtered on `{ "var": "stage" }` and `{ "var": "search" }`, an `aggregate` dataset `byStage` grouped by stage, two variables, and one operation `close_deal` with `confirm`.

## Overview — the figure band

The top of a "how are we doing" page. Each figure carries its comparison; the chart explains the leading one; the rows behind it stay one click away.

```vue
<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
  <div v-for="kpi in kpis" :key="kpi.label" class="rounded-xl border border-default bg-elevated/40 p-4">
    <div class="flex items-baseline justify-between gap-2">
      <p class="font-display text-3xl leading-none tabular-nums" :class="kpi.lead ? 'text-primary' : 'text-highlighted'">
        {{ kpi.value }}
      </p>
      <span
        v-if="kpi.delta !== undefined"
        class="flex items-center gap-1 text-xs font-medium tabular-nums"
        :class="kpi.delta >= 0 ? 'text-success' : 'text-error'"
      >
        <UIcon :name="kpi.delta >= 0 ? 'i-lucide-trending-up' : 'i-lucide-trending-down'" class="size-3.5" />
        {{ Math.abs(kpi.delta) }}%
      </span>
    </div>
    <p class="mt-2 text-xs uppercase tracking-wide text-muted">{{ kpi.label }}</p>
    <UProgress v-if="kpi.share !== undefined" :model-value="kpi.share" size="xs" class="mt-3" />
  </div>
</div>
```

Each `kpi` comes from an **aggregate** dataset — one for the current period, one for the previous — so the delta is computed by the server over the whole table, not over the page of rows you happen to be showing. A figure with no available comparison drops out of this band and becomes a line of text elsewhere.

Pair it with a chart wired as in `references/data.md` § Charts, in a region with an explicit height, and a legend you build yourself so it can carry counts and shares.

## Board — columns you can drag between

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

The definition behind it: a `records` dataset for the cards, and one operation `set_stage` taking `cardId` and `stage`.

**For a reorder inside one list** rather than a move between containers, the same two calls apply to the rows, plus `attachClosestEdge` in the drop target's `getData` (so the drop knows whether the pointer was above or below the row it landed on), `extractClosestEdge` on drop, and `reorder({ list, startIndex, finishIndex })` for the array move.
