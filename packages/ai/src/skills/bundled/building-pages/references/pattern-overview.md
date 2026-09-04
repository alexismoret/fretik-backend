# Pattern — the figure band

A skeleton with REAL wiring, not a template to fill in. Siblings: `pattern-directory.md` (filter, scan, open, act), `pattern-workbench.md` (queue beside item), `pattern-detail.md` (one record in full), `pattern-board.md` (drag and drop).

## What a finished figure band has

- One figure that LEADS, two or three times the size of the others. A band of equal figures says the page has no subject.
- A comparison on every figure — against the previous period, the total, a target. A number with none is a line of text, not a headline.
- Aggregates from the server (one `aggregate` dataset per period), never a sum over the page of rows that happens to be loaded.
- Something behind the lead figure that explains it: its distribution, its trend, or the few rows driving it.
- A route from the band to the rows: clicking a figure filters the view below it.

## The band

Four equal cards in a row is the shape a generated page defaults to, and it is what this band is written to avoid: the lead figure carries the page, the rest support it.

```vue
<section class="grid grid-cols-12 gap-4">
  <!-- The lead: what the page is about, before any label is read. -->
  <div class="col-span-12 lg:col-span-5">
    <p class="text-xs uppercase tracking-wide text-muted">{{ lead.label }}</p>
    <p class="font-display text-5xl leading-none tabular-nums tracking-tight text-highlighted">
      {{ lead.value }}
    </p>
    <p class="mt-2 flex items-center gap-1.5 text-sm tabular-nums" :class="lead.delta >= 0 ? 'text-success' : 'text-error'">
      <UIcon :name="lead.delta >= 0 ? 'i-lucide-trending-up' : 'i-lucide-trending-down'" class="size-4" />
      {{ Math.abs(lead.delta) }}% <span class="text-muted">vs {{ lead.against }}</span>
    </p>
    <!-- The distribution behind the number, so the figure carries its own shape. -->
    <UProgressGroup v-if="lead.parts" :items="lead.parts" size="sm" class="mt-4" status />
  </div>

  <!-- The supporting figures: same rhythm, a third of the weight, and each one filters the view below. -->
  <div class="col-span-12 grid grid-cols-3 gap-4 lg:col-span-7">
    <button
      v-for="figure in supporting"
      :key="figure.key"
      type="button"
      class="rounded-lg border border-default p-3 text-left transition-colors hover:bg-elevated/60"
      :class="active === figure.key ? 'border-primary' : ''"
      :aria-pressed="active === figure.key"
      @click="active = active === figure.key ? null : figure.key"
    >
      <p class="font-display text-2xl leading-none tabular-nums">{{ figure.value }}</p>
      <p class="mt-1.5 text-xs text-muted">{{ figure.label }}</p>
    </button>
  </div>
</section>
```

The `<button>` here is the exception the control rule allows: this is not a form control, it is a region of the layout made clickable, and `UButton` would bring a control's padding and variants to something the size of a card. Everything a reader types or picks is still a Nuxt UI component. Note `:aria-pressed` — a filter that is on has to say so, or the review reads it as a target that does nothing.

Each figure comes from an **aggregate** dataset, one per period, so the delta is computed by the server over the whole table. A figure with no available comparison drops out of the band and becomes a line of text elsewhere.

Pair it with a chart wired as in `references/data.md` § Charts, in a region with an explicit height, and a legend you build yourself so it can carry counts and shares.
