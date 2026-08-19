# Pattern — directory: filter, scan, open, act

A skeleton with REAL wiring, not a template to fill in: read it, then change everything that should differ. Siblings: `pattern-overview.md` (the figure band), `pattern-board.md` (drag and drop).

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
                :name="option('stage', row.original.stage).icon"
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
