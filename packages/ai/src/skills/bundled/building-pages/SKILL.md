---
name: building-pages
description: Design a page — a live dashboard, directory, report or status view built from the team's data with managePage. Read before writing a page definition. Covers page archetypes, layout and responsive rules, conditional styling by binding, typed values, charts, filters and drill-down, and the dataset patterns. Use when the request is a dashboard, a view, "visualise X", "track X", "somewhere to follow Y", or when a public link to living numbers is wanted.
---

# building-pages skill

Every style value comes from the design system, so a page cannot look broken by accident. What is left is judgment: what the reader needs to SEE, what they need to CHANGE, and how finished it looks when they open it.

**This file is the judgment; `get_catalog` is the reference.** Read both before your first definition.

The bar: indistinguishable from a page a good front-end engineer would hand-write for the same request. Icons where they orient, colour where it means something, a caption under every chart, a comparison beside every number, an empty state that names the filter.

## Before writing anything

1. `listObjects`, then `describeObjectType` for every type you will query. It returns the `objectTypeId` (the uuid a dataset needs — **never** reconstruct it from the `data.obj_…` table name, which drops the dashes), the field KEYS and TYPES, and every `select` option with its label.
2. **Do not probe with `querySql`.** Between `describeObjectType` for the schema and `dry_run` for the real rows, there is no question left that SQL answers.
3. Decide the ONE question the page answers. A page that answers one question well beats a page that shows everything.
4. Decide what the viewer changes: a period, a category, an owner. Each becomes a state variable.

## Page archetypes

Pages are not all dashboards. Pick the shape that matches the request:

| Request sounds like…                   | Shape                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "track", "monitor", "how are we doing" | **Dashboard** — filters, a KPI row, two or three charts, a detail table                             |
| "list of", "directory", "who / which"  | **Directory** — a search `input`, filter chips, then a `table` with typed cells (or repeated cards) |
| "report on", "summary of", "brief"     | **Report** — `section` bands of prose (`markdown`, `rich_text`) with one figure each                |
| "status of", "where does X stand"      | **Status** — one `stat` with `emphasis: "hero"`, a `timeline` or `stepper`, a `key_values` block    |
| "compare A and B"                      | **Comparison** — a `grid` of two mirrored columns, same elements on both sides                      |
| "detail of one X"                      | **Record view** — `identity` header, `key_values` body, related `table` below                       |

A dashboard opens with numbers. A report opens with a sentence. Do not give a report a KPI row because dashboards have one.

A view of ONE record pins that record: filter the dataset to its key, and put the same filter on every aggregate the page shows. Unfiltered, the page reads whichever row came back first and its KPIs total the whole table under a title naming one.

## Layout

Work top-down in bands.

- **`grid` is the page skeleton, `box` is the flow inside it.** A row of chips, a label beside a value, an icon before a number — all `box`. Nesting a `box` inside a grid cell is normal and expected.
- `grid` is 12 columns and steps down on its own: 4 across becomes 2 on a tablet and 1 on a phone. Set `span` for desktop and let it stack. Spell out `{ base, sm, md, lg }` only when the tablet step must differ from that automatic one.
- **Quote numeric scale values**: `span: "4"`, `cols: "3"`. A bare number is coerced, but write it right.
- `card` when a block needs a title and a border — and give the card the `title`/`description` rather than putting a `heading` inside it. Do not wrap every element in one; a page of boxed boxes reads as noise.
- `section` for a titled band of the page. `eyebrow` above the title is the cheapest way to tell a reader where they are.
- `box` with `surface` + `border` + `radius` builds a tinted panel without a card — the way to set one block apart without adding a frame.
- Past seven blocks in one view: split with `tabs`.

The dashboard rhythm, when that is the shape: filters (`box`, `direction: row`, `wrap`) → KPI row (`grid` of `stat`, `span: "3"`) → charts (`span: "6"` for a pair, `"12"` for a time series) → detail table (`span: "12"`, last).

## Conditional styling is a binding

**This is what makes a page look authored rather than stamped.** Any prop takes a binding, so any prop can respond to the data:

```json
{
  "type": "badge",
  "props": {
    "label": { "$": "item.status" },
    "color": {
      "$": "item.overdue ? 'error' : item.status = 'done' ? 'success' : 'neutral'"
    }
  }
}
```

```json
{
  "type": "text",
  "props": {
    "text": { "$": "item.margin" },
    "format": "percent",
    "color": {
      "$": "item.margin < 0 ? 'error' : item.margin > 0.3 ? 'success' : 'neutral'"
    },
    "icon": { "$": "item.margin < 0 ? 'trending-down' : 'trending-up'" }
  }
}
```

```json
{
  "type": "stat",
  "props": {
    "label": "Support backlog",
    "value": { "$": "data.kpi[0].open" },
    "compare": { "$": "data.kpi[0].open_prev" },
    "compareLabel": "vs last week",
    "deltaColor": {
      "$": "data.kpi[0].open > data.kpi[0].open_prev ? 'error' : 'success'"
    }
  }
}
```

That last one matters: a rising backlog is bad, a rising revenue is good, and the tile cannot know which. The delta's colour and icon default to the SIGN — override them whenever the sign does not mean what it looks like (cost, churn, latency, delay, headcount freeze).

`emphasis: "hero"` makes one number the headline. **One per view.** Two heroes is no hero.

Colour: the seven semantic tokens (`primary`, `success`, `warning`, `error`, `info`, `secondary`, `neutral`) carry MEANING and follow the workspace theme. Every Tailwind hue (`indigo`, `amber`, `teal`, …) is also accepted and is for ENTITY data and decoration — a category, a team, a themed band. Use a semantic token when the colour says "this is good/bad"; use a hue when it says "this is the marketing one".

A binding that resolves outside a prop's allowed values falls back and is reported, so guard your fallback branch.

## Typed values — let the workspace do the work

An `objects` dataset ships its field types with the data. Because of that:

- A **table cell** over a `select` renders that option's own coloured badge, money keeps its currency, a rating becomes stars, a date is localised, a boolean becomes a check. **You write nothing.** Do not set `format: "text"` on a status column — it would throw the type away.
- The `field` component does the same for one value anywhere else (a detail card, a repeated row): `{ "type": "field", "props": { "dataset": "invoices", "key": "status", "value": { "$": "item.status" } } }`. `key_values` takes the same pair — `dataset` on the block, `key` on each item — and without it a status reads as raw text beside a table showing it as a badge.
- A `table_cell` CHILD of the table replaces one column with your own subtree — `{ "type": "table_cell", "props": { "column": "owner" }, "children": ["owner-identity"] }` — with the row in scope as `item`. Use it when the automatic render is not enough: a name plus an avatar (`identity`), a value plus a trend arrow, a bar beside a number. Keep it small: eight elements, three levels.

Precedence, once: **a `table_cell` › explicit `format` › the field's type › what the value looks like › plain text.**

## Choosing the component

| The reader needs to…        | Use                                                                       |
| --------------------------- | ------------------------------------------------------------------------- |
| know one number now         | `stat`                                                                    |
| compare categories          | `chart_bar` (goes horizontal on its own past 6, or with long labels)      |
| see movement over time      | `chart_line`, or `chart_area` when the total matters as much as the shape |
| judge a share of a whole    | `chart_donut` — six slices at most                                        |
| find a specific row         | `table`                                                                   |
| read one record's fields    | `key_values`                                                              |
| see a person or a company   | `identity`                                                                |
| follow a history            | `timeline`                                                                |
| follow an ordered process   | `stepper` (only when order carries information)                           |
| track progress to a target  | `progress` (`variant: "ring"` for a compact one)                          |
| emphasise inside a sentence | `rich_text`                                                               |
| see nothing, on purpose     | `empty_state`                                                             |

**Is it even a chart?** Two or three categories is a `stat`, or two side by side — it reads faster and takes a quarter of the space. Thirty columns is a spreadsheet, not a table: pick the ones that answer the question.

## Charts

- **Every metric gets a `label`, and a `unit` if it has one** — it becomes the legend entry, the axis title, the tooltip row and the column header at once. Without it the chart says `nb` or `m0`.
- A caption is generated from the dataset ("Gross margin by month (THB)"). Write your own `caption` when you can say something better — what the number means, not what it is.
- `seriesBy` on the dataset needs `series: "series"` on the chart. Without it every group collapses into one flat line.
- Past 8 series the tail folds into a grey "Other" automatically. If you are near that, group the data instead.
- **There is no second y-axis, by design.** Two measures of different scale: two charts side by side, or index both to a common base in a `transform`.
- Values between 0 and 1 want `format: "percent"`, not `number`.

## Datasets

- **`objects` + `mode: "aggregate"`** for anything a chart or a KPI shows. Let the database group and sum; never pull rows to count them in an expression.
  - `groupBy` a category field, or a date field with `dateBucket` (`month` is usually right).
  - `metrics: [{ name, fn, key, label, unit }]` — `name` is the row key you bind to; `label` is what a human reads.
  - `seriesBy` adds a second dimension: stacked bars, multi-series lines.
  - Omit `groupBy` for a single scalar row — the KPI shape. Add a second metric filtered to the previous period and you have your `compare`.
- **`objects` + `mode: "records"`** for tables and lists. `limit` is the PAGE SIZE, not a ceiling: a table over one pages and sorts server-side, so 25–100 serves a type of any size and the reader still sees the real total. Two follow-ons: a column total then covers one page only — use an aggregate dataset for a figure that holds; and give a paginated table its own dataset, since paging re-queries it under anything else reading it.
- **`transform`** when the answer is not a query: a derived column, a ratio between datasets, a set difference, a join. Declare `inputs`, read them as `data.<id>`. The code is **JavaScript** — the body of `(data, state) => …`, so it must `return` its rows. Give it results a query already reduced: grouping and summing belong to an aggregate dataset, which does it in SQL over every row instead of over the few thousand a transform can hold.
- **`inline`** for small fixed reference data the team has no table for — targets, thresholds, conversion rates. Never for query results: embedding rows freezes them, which is what a page exists to avoid.
- **`external`** for a small, live read from a connected app — an inbox, today's orders, this week's tickets. Its value is freshness: the answer is cached for a minute or so and re-read on every visit.

**Choosing between `external` and a workflow that syncs into an object type** — the question is what the data has to survive:

| Use `external`                 | Sync into an object type instead                  |
| ------------------------------ | ------------------------------------------------- |
| Tens of rows, read as-is       | Thousands, or filtered/grouped/sorted server-side |
| Freshness is the point         | History, trends, or anything compared over time   |
| Each viewer sees THEIR account | Everyone must see the same rows                   |
| Internal page                  | The page must be published                        |

The reason is not policy: a third party cannot be filtered or indexed the way an object type can, so a page that asks it for volume pays a network round trip for rows nobody sorted.

## Interactivity

State variables are the only moving parts. Three wires, and nothing else:

- A control writes state through a two-way binding on its value prop: `"value": { "$bindState": "/period" }` on a `select`, `button_group`, `date_range`, … A fixed value there makes a control that looks live and changes nothing.
- A dataset filter binds to state — `{ key: "month", op: "eq", value: { "$": "state.period" } }` — so changing the control re-queries the server.
- Any prop can bind to state or data for display.

An **"All" option is `value: ""`** — an empty value drops its filter server-side, so the reset needs no special case. Give it a label ("All", "Any owner"), never an empty one.

Drill-down is the same mechanism: `row_click` on a table runs `{ "action": "setState", "params": { "statePath": "/selected", "value": { "$": "item.id" } } }`, and a block below filters on it. Use the element's `visible` to hide the detail until something is selected, and pair it with an `empty_state` that says what to click.

Repeating content is `repeat` on any container — `{ "statePath": "/data/deals" }` on a `box` renders its children once per row, each read as `item.<field>`.

Prefer a `button_group` to a `select` at five options or fewer — visible choices get used, hidden ones do not.

## Forms and writes

A page that only shows things is half a page. An `operations` entry is a write into a connected app; the `run` action fires it.

- **A form field is a variable.** Declare it in `variables`, bind the control with `$bindState`, and read it in the operation's `args` as `state.<key>`. There is no separate form model to learn, and the value arrives typed.
- Put the controls in a `form` and bind the run to its `submit`: Enter in a field and a `submit: true` button both fire it, and required fields are checked first. Give each control a `label` — that is what turns it into a labelled field with its required marker.
- `onSuccess.refetch` names the datasets to re-run, which is how the page shows the thing that was just created. Add `resetVariables` so the next entry starts clean, and a `toast` in the user's own terms.
- `confirm` is REQUIRED for anything the app marks destructive — the server refuses the operation without it. Add one to anything irreversible even when it is not.

Worked shape, an order entry form:

```json
"operations": [{
  "id": "create_order",
  "providerKey": "acme-orders",
  "action": "create_order",
  "args": { "reference": { "$": "state.reference" }, "quantity": { "$": "state.quantity" } },
  "onSuccess": { "refetch": ["orders"], "toast": "Order created", "resetVariables": ["reference", "quantity"] }
}]
```

with `{ "type": "button", "props": { "label": "Create", "submit": true } }` inside a `form` whose `submit` runs `{ "action": "run", "params": { "operation": "create_order" } }`.

## Expressions

The catalog states the grammar; these are the judgment calls it cannot make.

- Aggregate with `$sum`, `$average`, `$count`, `$min`, `$max`; filter with a predicate: `data.sales[status='won']`.
- Keep expressions short. A binding is a dotted path with a little arithmetic — anything needing several steps belongs in a `transform`, which is JavaScript, computed once instead of on every render.
- Never format numbers or dates by hand. Set `format` and the page renders them in the viewer's own locale.

## Editing a page you already built

Send `patch` — RFC 6902 ops rooted at the definition — never a whole `definition`. One op reaches one element, one dataset filter, one theme value; a full rewrite is how an element that was fine disappears. `get` the page first when you are unsure of the current keys.

Building in passes is the same move: `create` without `spec` opens the page on its datasets, then add the elements a few ops at a time. A page that exists cannot be lost by a later rewrite.

## The finished checklist

Before you hand a page over:

- [ ] Every chart's caption reads as a sentence a person would say.
- [ ] Every KPI has a `compare` — a number with nothing to measure it against says very little.
- [ ] Icons on cards, sections and stats — chosen to orient, not to decorate.
- [ ] Colour means something everywhere it appears, and the meaning is right (check every delta).
- [ ] Empty states name the active filter, not the absence: "No invoices for March", not "No data".
- [ ] `warnings` empty; `polish` read, and acted on or consciously left.

`samples` on the same result shows what actually came back — row counts, distinct group values, field types, one real row. Check your bindings against it; a dataset returning zero rows is a wrong filter far more often than missing data.

## Publishing

Ask the user before you `publish`, and say plainly what will be visible: the link needs no account and exposes everything the owning team can see. Member fields show a name only, never a profile.

A page that reads a connected app or writes to one CANNOT be published — an anonymous visitor would be spending the team's credentials. If the user wants both, sync the data into an object type with a workflow and publish a page over that.

## When a page is the wrong answer

- A one-off number, asked once → answer in the conversation.
- A frozen report to send as a file → build it in the sandbox and `presentFiles`.
- Work that must HAPPEN on a schedule rather than be looked at → a workflow. A workflow that fills an object type and a page that reads it is often the right pair.
