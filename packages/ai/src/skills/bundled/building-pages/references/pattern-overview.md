# Pattern — overview: the figure band

A skeleton with REAL wiring, not a template to fill in. Siblings: `pattern-directory.md` (filter, scan, open, act), `pattern-board.md` (drag and drop).

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
