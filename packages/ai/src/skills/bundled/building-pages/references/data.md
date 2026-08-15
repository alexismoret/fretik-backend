# Data and actions

The data half of a page is declarative, and it is the security boundary: the code can only ask for what the definition declared. `managePage { action: "get_guide" }` carries the full grammar — this file is how to use it well.

## Declaring

- **Variables are the request contract.** Declare one per value the SERVER needs — a filter, an operation argument. Send them with `fretik.data.query({ variables })` and reference them inside filters and args as `{ "var": "key" }`. Purely local UI state (which row is selected, whether a panel is open) is a ref, not a variable.
- **A figure that must be true is an `aggregate` dataset.** Summing a page of rows in JavaScript lies the moment the table pages. Use `groupBy` / `dateBucket` and metrics with `label` and `unit`.
- **A paginated list gets its own `records` dataset.** The server is the paginator, however many millions sit behind it.
- **`transform` combines what the queries already reduced** — ratios, joins, derived columns. Plain JavaScript, `return` its rows. Never group or sum there what an aggregate dataset should.
- **`external` is for small, fresh reads** through the viewer's own connection — an inbox, today's events. Volume and history belong in an object type synced by a workflow: a third party cannot be filtered, grouped or indexed. `dry_run` shows the real answer shape first.
- **Probe before you design.** `dry_run` with datasets and no `code` returns real field names, a real row and real distinct values. Never design against imagined fields.

## Reading

```ts
const result = await fretik.data.query({ variables, datasetIds, queries });
```

Every dataset comes back as one of `{ status: "ok", rows, fields, totalCount?, page?, pageSize? }`, `{ status: "error", message }`, `{ status: "forbidden" }`, or `{ status: "needs_connection", providerKey }`. **Render all four.** A page that only handles `ok` shows a blank region when a query fails, and the user cannot tell it apart from "no data".

Load everything once on mount, then refetch narrowly with `datasetIds`.

## `fields` is the display dictionary

Rows hold what the database holds. `fields` is what turns that into something a person reads — and using it is what makes your page agree with every other view of the same records.

```ts
// fields: [{ key, label, type, options?, currencyCode?, ... }]
const meta = computed(() =>
  Object.fromEntries((rows.value.fields ?? []).map((f) => [f.key, f])),
);

const display = (key: string, value: unknown) => {
  const field = meta.value[key];
  if (value === null || value === undefined || value === "") return "—";
  switch (field?.type) {
    case "select":
      return (
        field.options?.find((o) => o.value === value)?.label ?? String(value)
      );
    case "multi_select":
      return (value as string[]).map(
        (v) => field.options?.find((o) => o.value === v)?.label ?? v,
      );
    case "money": {
      const { amount, currencyCode } = value as {
        amount: number;
        currencyCode?: string;
      };
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: currencyCode ?? field.currencyCode ?? "EUR",
      }).format(amount);
    }
    case "date":
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(String(value)),
      );
    default:
      return String(value);
  }
};
```

- Column headers and form labels are `field.label`, never the key.
- The locale is `fretik.context.locale` — pass it to every `Intl` call. Hardcoding one produces `€80,000,000` for a French team instead of `80 000 000 €`.
- **Large money and counts get compact notation**: `Intl.NumberFormat(locale, { notation: "compact", style: "currency", currency, maximumFractionDigits: 1 })` → `80 M€`. A column of full-length amounts is unreadable and hides its own outliers.
- Missing values render as an em dash, never `null`, never an empty cell.
- **Long text is usually markdown** — a `long_text` field holds whatever was written into it, headings and tables included. Render it with `<Markdown :value="text" />` (registered globally, no import, same renderer and typography as the rest of the app; `compact` clamps it to two lines for a cell). Interpolating it raw puts `### Heading` in front of the reader.

Anything you interpolate without going through this is a raw key, an object or an ISO string landing in front of a user.

## Colour and icons come from the schema

Every `select` and `multi_select` option carries `color` (a palette name — `blue`, `amber`, `violet`, …, `zinc` for none) and often `icon` (a bare lucide name — `phone`, `zap`). **Using them is what makes a page look like part of the product rather than a grey report**, and it is what keeps a status the same colour here as everywhere else in the app.

A palette name cannot become a Tailwind class: `bg-${color}-500` is assembled at runtime and compiles to nothing. Bind the CSS variable instead — the whole palette is live in the runtime, and it adapts to light and dark on its own. This is the same recipe the rest of the app uses:

```ts
const swatch = (color?: string | null) => {
  const base = `var(--color-${color ?? "zinc"}-500)`;
  return { fg: base, bg: `color-mix(in oklab, ${base} 14%, transparent)` };
};
// CSS resolves `var()`; a <canvas> does not. For anything drawn — a Chart.js
// colour — go through `fretik.theme.color(name)` instead (§ Charts).
const icon = (name?: string | null) => (name ? `i-lucide-${name}` : undefined);
```

```vue
<!-- a select value, rendered the way the objects UI renders it -->
<span
  class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
  :style="{
    color: swatch(opt?.color).fg,
    backgroundColor: swatch(opt?.color).bg,
  }"
>
  <UIcon v-if="opt?.icon" :name="icon(opt.icon)" class="size-3.5" />
  {{ opt?.label }}
</span>
```

Three rules make this hold together:

- **Same value, same colour, everywhere it appears** — cell, chart segment, legend, filter, detail panel. Colouring a category in one region and greying it in another is worse than not colouring it at all.
- **A colour belongs to the value, not to its state.** Selection, hover and filtering are expressed with background, weight or a ring — never by changing the category's own colour, which makes it unrecognisable exactly when the user is looking at it.
- **Fill colour gaps from a deterministic ramp, option by option.** An option with no colour of its own takes a hue derived from its position — the same one on every render — instead of collapsing to neutral. Apply this per option, never per field: a field is rarely all-coloured or all-bare, and the one bare value can be the one holding most of the rows, leaving a chart that is a single invisible grey. Reserve neutral for a value that genuinely means "none".

## Build the page from the schema, not from today's rows

`fields` describes what the data CAN be; the rows are only what it happens to be this morning. A page built from the rows silently degrades the moment the data moves.

- **Controls come from `options`, not from the values present.** Every choice the field allows gets a control, with the empty ones shown at zero rather than omitted — that is what teaches the user the shape of their own process, and it stops the page reshaping itself as records move.
- **Categories in a chart come from the same place**, so a value appearing next week keeps its colour and its position instead of shifting everything.
- **Columns and sections are chosen from the fields worth scanning**, once, not from whichever keys the first row happened to carry.
- A dataset that is empty today still gets its section and its empty state. Sections that appear and disappear with the data make a page impossible to learn.

Read the type with `describeObjectType` before writing the datasets: it gives you every field, every option, and the icons and colours attached to them.

## Writing

Operations are the only writes.

```ts
const verdict = await fretik.ops.run("close_deal", { variables: { dealId } });
if (verdict.status === "ok") {
  toast.add({ title: "Deal marked won", color: "success" });
  await load(["deals", "totals"]); // refetch what the write changed
} else if (verdict.status !== "cancelled") {
  toast.add({ title: verdict.message ?? "The action failed", color: "error" });
}
```

Declare `confirm: { title, description? }` on every destructive operation. **The app renders that confirmation itself**, outside the page, from the stored definition — so never build your own confirm dialog for a destructive op, and never treat `cancelled` as a failure. Show pending state on the control that started it, not over the whole page.

## Charts

`import Chart from "chart.js/auto"` — everything is pre-registered.

Two traps, and both fail silently.

**A canvas cannot resolve a CSS variable.** `fillStyle` parses a colour, not a custom property: hand Chart.js `"var(--color-blue-500)"` and the value is dropped without an error, leaving the canvas default — black. So the `swatch()` recipe above, which is exactly right for a `:style` binding, produces an invisible chart. Resolve first, with `fretik.theme.color(…)`, which takes a palette name (`"blue"`, `"blue-600"`, `"primary"`) or a raw var and returns the concrete value:

```ts
const segments = computed(() =>
  options.map((o) => ({
    label: o.label,
    value: tally.get(o.value) ?? 0,
    color: fretik.theme.color(o.color ?? ramp(o.value)),
  })),
);
```

It re-resolves when the host switches light/dark, so a chart rebuilt from a `computed` recolours with the app instead of keeping the palette it was born with.

**A canvas behind `v-if="pending"` does not exist yet when the data arrives.** A default watcher runs before the DOM updates, finds no canvas, and silently draws nothing.

```ts
const chartEl = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

watch(
  breakdown,
  (data) => {
    if (!chartEl.value) return;
    chart?.destroy(); // never stack instances
    chart = new Chart(chartEl.value, {
      type: "doughnut",
      data: {
        labels: data.map((d) => d.label),
        datasets: [
          {
            data: data.map((d) => d.value),
            backgroundColor: data.map((d) => d.color),
            borderWidth: 0,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
      },
    });
  },
  { flush: "post" },
); // ← after the DOM exists

onUnmounted(() => chart?.destroy());
```

- Give the canvas's wrapper an explicit height (`class="relative h-64"`) — `maintainAspectRatio: false` needs one.
- Colours come from the field's own option colours when the series is a status; otherwise one hue ramp. Never one random hue per series.
- Build your own legend when the chart is a doughnut — a legend row you control can carry counts and shares the chart cannot.

## Live pages

Poll only when the page is genuinely a live board: `setInterval(() => load(), 30_000)` with `clearInterval` in `onUnmounted`. Dim the content while refetching; never blank it, and never re-run entry animations on a refresh.
