import { defineCatalog } from "@json-render/core";
import { z } from "zod";
import { BUILT_IN_ACTIONS } from "../core/built-in-actions";
import { createPropValidator, shapeOf } from "../core/props";
import { scale } from "../core/scales";
import { elementTreeSchema } from "../core/schema";

/**
 * The PAGES catalog — every component a page may be built from.
 *
 * ONE source: the prompt the agent reads, the JSON Schema, the props the
 * frontend registry is typed from, and the value lists the runtime checks a
 * resolved binding against. The hand-mirror this replaces drifted once already.
 *
 * A CURATED SEMANTIC VOCABULARY, not a wrapper over Nuxt UI's 122 components —
 * the same call json-render's own first-party catalog makes (36 hand-written
 * entries for shadcn's ~50, inventing `Stack`/`Grid`/`Heading`/`Text` because
 * a design system has no semantic layer). Three reasons it is not a close
 * call: no codegen exists in either direction, so "expose the library" means
 * hand-writing 122 entries anyway; the prop surfaces are unusable by a model
 * (`USelectMenu` alone carries ~126 typed members, most of them slot and class
 * overrides); and `class` — the escape hatch their catalog exposes — renders
 * unstyled here, because Tailwind compiles at build time.
 *
 * Two conventions, both deliberate:
 *
 * - **Prop schemas are LITERAL.** They never spell out "or a binding" even
 *   though every prop accepts one. `propsOf` collapses to an open record past
 *   one component, so a union would buy no validation and would print
 *   `text: string | { $: string } | { $state: string }` 48 times. The binding
 *   forms are documented once, under "Dynamic values".
 * - **Defaults live in the Vue components**, not here. A default is a
 *   rendering guarantee, and `withDefaults` is where a Vue reader looks for
 *   it. Everything optional here is genuinely optional.
 *
 * Anything a TYPE can carry belongs in the zod — `Array<{ label: string }>`
 * validates AND reads better than prose. `notes` carries only what a type
 * cannot say, because `formatZodType` ignores `.describe()`.
 *
 * Form validation (`checks` / `validateOn`, which the shadcn catalog puts on
 * its inputs) is deliberately absent: a page is read-only, and a surface that
 * validates input is a form. It belongs to the `forms` catalog, on this same
 * core.
 */

// ==================== //
// SHARED FRAGMENTS     //
// ==================== //

/** A display value normally bound to the data rather than typed in. */
const bound = z.union([z.string(), z.number()]);

const orientation = z.enum(["vertical", "horizontal"]);

const optionList = z.array(
  z.object({ value: z.string(), label: z.string().optional() }),
);

/**
 * What turns a bare control into a labelled FIELD. Optional everywhere: a
 * filter bar wants a placeholder and nothing else, while a data-entry form
 * wants a label and a required marker. The renderer wraps the control in a
 * form field as soon as a label is present, so the author asks for a label
 * rather than for a wrapper.
 *
 * TWO props, not four. `description` and `hint` were both here and were cut:
 * printed across seven controls they cost more than the label plus the
 * placeholder already say, and this catalog has been over its size ceiling
 * once already for exactly that reason (see `chartNotes`).
 */
const fieldProps = {
  label: z.string().optional(),
  required: z.boolean().optional(),
};

/** Props every chart shares. */
const chartProps = {
  dataset: z.string(),
  caption: z.string().optional(),
  height: scale("size").optional(),
  format: scale("format").optional(),
  currency: z.string().optional(),
  legend: z.boolean().optional(),
};

/**
 * Deliberately EMPTY. `caption` and `legend` behave identically on all four
 * charts, so their prose lives in the preamble's conventions block — printed
 * once instead of four times. Kept as a named spread so a note that is genuinely
 * chart-wide (and not preamble material) still has an obvious home.
 */
const chartNotes = {};

const chartMeta = { group: "chart", datasetProps: ["dataset"] };

/** x / y / series — shared by the three cartesian charts. */
const axisProps = {
  x: z.string().optional(),
  y: z.union([z.string(), z.array(z.string())]).optional(),
  series: z.string().optional(),
};

/** Empty for the same reason as `chartNotes` — see the preamble's chart line. */
const axisNotes = {};

// ==================== //
// CATALOG              //
// ==================== //

export const pagesCatalog = defineCatalog(elementTreeSchema, {
  components: {
    // ---------- layout ----------
    box: {
      props: z.object({
        direction: scale("direction").optional(),
        gap: scale("gap").optional(),
        align: scale("align").optional(),
        justify: scale("justify").optional(),
        wrap: z.boolean().optional(),
        maxWidth: z.enum(["sm", "md", "lg", "xl", "2xl", "full"]).optional(),
        maxHeight: scale("size").optional(),
        surface: scale("surface").optional(),
        border: z.boolean().optional(),
        radius: scale("radius").optional(),
        color: scale("color").optional(),
      }),
      slots: ["default"],
      description:
        "flexbox container — the main layout primitive. Also how you build a tinted strip or a bordered panel without a card. Put `repeat` on it to render its children once per row.",
      notes: {
        color: "tints this box and everything inside it",
        maxHeight: "adds scrolling past that height",
      },
      meta: { group: "layout", responsive: ["direction"] },
    },
    grid: {
      props: z.object({
        cols: scale("cols").optional(),
        gap: scale("gap").optional(),
        align: scale("align").optional(),
      }),
      slots: ["default"],
      description:
        "responsive grid; children set `span`. Two intermediate steps are inserted automatically, so 4 columns become 2 on a tablet and 1 on a phone.",
      meta: { group: "layout", responsive: ["cols"] },
    },
    card: {
      props: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        variant: scale("variant").optional(),
        color: scale("color").optional(),
        highlight: z.boolean().optional(),
      }),
      slots: ["default"],
      description:
        "titled surface. Give it the title and description rather than putting a `heading` inside it.",
      notes: { highlight: "accent ring around the card" },
      meta: { group: "layout" },
    },
    form: {
      props: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        variant: scale("variant").optional(),
        color: scale("color").optional(),
      }),
      slots: ["default"],
      events: ["submit"],
      description:
        "data-entry surface. Put controls inside, give each a `label`, and bind a `run` action to `submit`: Enter in a field and a `submit: true` button both fire it, and required fields are checked first.",
      meta: { group: "interactive" },
    },
    section: {
      props: z.object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        variant: scale("sectionVariant").optional(),
        align: scale("textAlign").optional(),
        color: scale("color").optional(),
      }),
      slots: ["default"],
      description:
        "a titled band of the page. Same props at four scales: `hero` opens a page, `feature` presents, `cta` closes, `plain` is a bare group.",
      notes: { eyebrow: "small label above the title" },
      meta: { group: "layout" },
    },
    tabs: {
      props: z.object({
        value: z.string().optional(),
        variant: z.enum(["pill", "link"]).optional(),
      }),
      slots: ["default"],
      description: "tab bar; its children must be `tab` elements.",
      notes: {
        value:
          "bind it with $bindState — each `tab` child declares the matching `value`",
      },
      meta: { group: "layout", bindable: ["value"] },
    },
    tab: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        icon: z.string().optional(),
        badge: bound.optional(),
      }),
      slots: ["default"],
      description:
        "one tab panel; its children render when the parent's bound value equals its `value`.",
      notes: { badge: "count shown on the tab" },
      meta: { group: "layout" },
    },
    modal: {
      props: z.object({
        open: z.boolean().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        size: scale("size").optional(),
      }),
      slots: ["default"],
      description:
        "overlay panel — how a directory opens one row's detail without leaving the page. Bind `open` with $bindState and set that path from a `row_click` or a button.",
      meta: { group: "layout", bindable: ["open"] },
    },
    divider: {
      props: z.object({
        label: z.string().optional(),
        icon: z.string().optional(),
      }),
      description: "horizontal rule, optionally labelled.",
      meta: { group: "layout" },
    },
    spacer: {
      props: z.object({ size: scale("size").optional() }),
      description: "vertical breathing room.",
      meta: { group: "layout" },
    },

    // ---------- display ----------
    heading: {
      props: z.object({
        text: z.string(),
        eyebrow: z.string().optional(),
        level: z
          .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .optional(),
        icon: z.string().optional(),
        color: scale("color").optional(),
        align: scale("textAlign").optional(),
      }),
      description: "section title.",
      meta: { group: "display" },
    },
    text: {
      props: z.object({
        text: bound,
        size: scale("textSize").optional(),
        weight: scale("weight").optional(),
        tone: scale("tone").optional(),
        color: scale("color").optional(),
        format: scale("format").optional(),
        currency: z.string().optional(),
        unit: z.string().optional(),
        icon: z.string().optional(),
        iconColor: scale("color").optional(),
        align: scale("textAlign").optional(),
        transform: scale("transform").optional(),
        tracking: scale("tracking").optional(),
        mono: z.boolean().optional(),
        lines: z.number().optional(),
      }),
      description:
        "a line of text — also the eyebrow, the caption, the icon+label pair and the big number. `format` runs through the viewer's locale.",
      notes: {
        color: "wins over `tone`",
        unit: "suffix printed after the value: kg, days, %",
        lines: "clamp to N lines",
      },
      meta: { group: "display" },
    },
    rich_text: {
      props: z.object({
        parts: z.array(
          z.object({
            text: bound,
            weight: scale("weight").optional(),
            tone: scale("tone").optional(),
            color: scale("color").optional(),
            icon: z.string().optional(),
            mono: z.boolean().optional(),
            format: scale("format").optional(),
            currency: z.string().optional(),
          }),
        ),
        size: scale("textSize").optional(),
        align: scale("textAlign").optional(),
      }),
      description:
        "one sentence whose parts are styled differently — the only way to emphasise INSIDE a line that reflows.",
      meta: { group: "display" },
    },
    markdown: {
      props: z.object({ content: z.string() }),
      description:
        "rich prose block (safe subset: headings, lists, bold, links).",
      meta: { group: "display" },
    },
    icon: {
      props: z.object({
        name: z.string(),
        size: scale("size").optional(),
        color: scale("color").optional(),
      }),
      description: "a standalone icon.",
      meta: { group: "display" },
    },
    image: {
      props: z.object({
        src: z.string(),
        alt: z.string().optional(),
        radius: scale("radius").optional(),
        ratio: scale("ratio").optional(),
        fit: scale("fit").optional(),
        caption: z.string().optional(),
      }),
      description: "an image by URL.",
      meta: { group: "display" },
    },
    stat: {
      props: z.object({
        label: z.string(),
        value: bound,
        format: scale("format").optional(),
        currency: z.string().optional(),
        unit: z.string().optional(),
        compact: z.boolean().optional(),
        compare: bound.optional(),
        compareLabel: z.string().optional(),
        delta: bound.optional(),
        deltaColor: scale("color").optional(),
        deltaIcon: z.string().optional(),
        deltaFormat: z.enum(["percent", "number"]).optional(),
        hint: z.string().optional(),
        trend: z.array(z.number()).optional(),
        icon: z.string().optional(),
        color: scale("color").optional(),
        emphasis: scale("emphasis").optional(),
        align: scale("textAlign").optional(),
      }),
      description:
        "KPI tile. A row of these with no `compare` on any of them reads as unfinished — a number with nothing to measure it against says very little.",
      notes: {
        compare:
          "the previous value; the delta and its sign are derived from it",
        delta: "explicit delta, overriding `compare`",
        deltaColor:
          "bind it — a falling cost is good, a falling revenue is not",
        compact: "1.2M instead of 1 200 000",
        trend: "drawn as an inline sparkline",
        hint: "small note under the label",
      },
      meta: { group: "display" },
    },
    badge: {
      props: z.object({
        label: bound,
        color: scale("color").optional(),
        variant: scale("variant").optional(),
        size: scale("size").optional(),
        icon: z.string().optional(),
        trailingIcon: z.string().optional(),
      }),
      description: "small status pill — fits inside table cells and lists.",
      meta: { group: "display" },
    },
    alert: {
      props: z.object({
        title: z.string(),
        description: z.string().optional(),
        color: scale("color").optional(),
        variant: scale("variant").optional(),
        icon: z.string().optional(),
      }),
      description: "callout banner.",
      meta: { group: "display" },
    },
    progress: {
      props: z.object({
        value: z.number(),
        max: z.number().optional(),
        color: scale("color").optional(),
        size: scale("size").optional(),
        variant: z.enum(["bar", "ring"]).optional(),
        label: z.string().optional(),
        showValue: z.boolean().optional(),
      }),
      description: "value against a target, as a bar or a ring.",
      meta: { group: "display" },
    },
    avatar: {
      props: z.object({
        src: z.string().optional(),
        alt: z.string().optional(),
        size: scale("size").optional(),
        items: z
          .array(z.object({ src: z.string().optional(), alt: z.string() }))
          .optional(),
        dot: scale("color").optional(),
      }),
      description: "round avatar, or a stacked group.",
      notes: {
        alt: "initials are derived from it",
        items: "renders a stacked group instead of one avatar",
        dot: "status dot on the corner",
      },
      meta: { group: "display" },
    },
    identity: {
      props: z.object({
        name: bound,
        description: bound.optional(),
        src: z.string().optional(),
        icon: z.string().optional(),
        size: scale("size").optional(),
        color: scale("color").optional(),
      }),
      description:
        "avatar + name + secondary line. The default way to show a person, a company or any named record in a cell or a list.",
      meta: { group: "display" },
    },
    key_values: {
      props: z.object({
        items: z.array(
          z.object({
            label: z.string(),
            value: bound,
            /** Field key behind this row — gives the value its typed render. */
            key: z.string().optional(),
            /** Overrides the block's `dataset` for this row only. */
            dataset: z.string().optional(),
            format: scale("format").optional(),
            currency: z.string().optional(),
            icon: z.string().optional(),
            color: scale("color").optional(),
            badge: z.boolean().optional(),
          }),
        ),
        dataset: z.string().optional(),
        columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        size: scale("textSize").optional(),
        divided: z.boolean().optional(),
      }),
      description:
        "a definition list — label on the left, value on the right. The detail panel of any record.",
      notes: {
        dataset:
          "name it, and give each item the field `key` it shows: the row then renders like the same field in a table — a select as its own badge, money with its currency, a weight with its unit",
        items: "set `badge` on an item to render its value as a pill",
      },
      meta: { group: "display", datasetProps: ["dataset"] },
    },
    timeline: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            date: z.string().optional(),
            icon: z.string().optional(),
            color: scale("color").optional(),
          }),
        ),
        orientation: orientation.optional(),
        size: scale("size").optional(),
        color: scale("color").optional(),
        reverse: z.boolean().optional(),
      }),
      description: "events on a rail — history, changelog, audit trail.",
      meta: { group: "display" },
    },
    stepper: {
      props: z.object({
        items: z.array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            icon: z.string().optional(),
          }),
        ),
        value: z.number().optional(),
        orientation: orientation.optional(),
        size: scale("size").optional(),
        color: scale("color").optional(),
      }),
      description:
        "progress through an ordered process — only when order matters.",
      notes: { value: "index of the current step" },
      meta: { group: "display" },
    },
    empty_state: {
      props: z.object({
        title: z.string(),
        description: z.string().optional(),
        icon: z.string().optional(),
        size: scale("size").optional(),
      }),
      description:
        "shown in place of content that has nothing to show. Name the active filter in the description rather than saying 'no data'.",
      meta: { group: "display" },
    },
    field: {
      props: z.object({
        value: z.unknown(),
        dataset: z.string().optional(),
        key: z.string().optional(),
        size: scale("size").optional(),
        label: z.string().optional(),
      }),
      description:
        "renders ONE value the way the workspace renders it: a select becomes its own coloured badge, money its currency, a rating its stars, a relation its chip. Prefer it over `text` for anything that came out of an object.",
      notes: {
        value: 'the raw value, normally bound: { "$": "item.status" }',
        dataset: "the dataset where that field is declared",
        key: "the field key inside that dataset",
        label: "also print the field's label above the value",
      },
      meta: { group: "display", datasetProps: ["dataset"] },
    },
    kbd: {
      props: z.object({ value: z.string() }),
      description: "keyboard key / code chip.",
      meta: { group: "display" },
    },
    tooltip: {
      props: z.object({ text: z.string() }),
      slots: ["default"],
      description: "wraps one child with a hover explanation.",
      meta: { group: "display" },
    },
    accordion: {
      props: z.object({
        label: z.string(),
        icon: z.string().optional(),
        defaultOpen: z.boolean().optional(),
      }),
      slots: ["default"],
      description: "collapsible section — good for dense detail below a chart.",
      meta: { group: "display" },
    },
    table: {
      props: z.object({
        dataset: z.string(),
        columns: z
          .array(
            z.object({
              key: z.string(),
              label: z.string().optional(),
              format: scale("format").optional(),
              currency: z.string().optional(),
              align: scale("textAlign").optional(),
              width: z.string().optional(),
            }),
          )
          .optional(),
        caption: z.string().optional(),
        pageSize: z.number().optional(),
        sticky: z.boolean().optional(),
        empty: z.string().optional(),
        emptyIcon: z.string().optional(),
        density: scale("density").optional(),
        totals: z.array(z.string()).optional(),
      }),
      slots: ["default"],
      events: ["row_click"],
      description:
        "data table. Cells are typed from the dataset's own fields, so a select renders as its coloured badge without being told; add `table_cell` children only to override a column. Over a records dataset it pages and sorts server-side on its own — headers become sortable and the count is the real total.",
      notes: {
        columns: "omit to take the dataset's own fields, in its own order",
        totals:
          "column keys summed in a footer row — hidden once the table pages, where a sum would only cover one page",
        pageSize:
          "ignored when the table pages server-side: the dataset's `limit` is the page",
        empty: "message shown when the dataset comes back with no rows",
      },
      meta: { group: "display", datasetProps: ["dataset"] },
    },
    table_cell: {
      props: z.object({ column: z.string() }),
      slots: ["default"],
      description:
        'overrides one column of the parent `table`. Its children render once per row with that row in scope — read it as { "$": "item.<field>" }.',
      meta: { group: "display" },
    },

    // ---------- interactive ----------
    button: {
      props: z.object({
        label: z.string(),
        icon: z.string().optional(),
        trailingIcon: z.string().optional(),
        color: scale("color").optional(),
        variant: scale("variant").optional(),
        size: scale("size").optional(),
        block: z.boolean().optional(),
        active: z.boolean().optional(),
        loading: z.boolean().optional(),
        disabled: z.boolean().optional(),
        submit: z.boolean().optional(),
      }),
      events: ["click"],
      description: "button running the actions bound to its `click` event.",
      notes: {
        active: "bind it — renders the button as selected",
        submit: "inside a form: submits it instead of firing `click`",
      },
      meta: { group: "interactive" },
    },
    button_group: {
      props: z.object({
        value: z.union([z.string(), z.array(z.string())]).optional(),
        options: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
            icon: z.string().optional(),
          }),
        ),
        color: scale("color").optional(),
        size: scale("size").optional(),
        multiple: z.boolean().optional(),
      }),
      events: ["change"],
      description:
        "segmented chips writing one state key — the idiomatic period or category switch.",
      notes: { value: 'bind it with $bindState. An "all" chip is value: ""' },
      meta: { group: "interactive", bindable: ["value"] },
    },
    dropdown_menu: {
      props: z.object({
        label: z.string().optional(),
        icon: z.string().optional(),
        items: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
            icon: z.string().optional(),
            color: scale("color").optional(),
          }),
        ),
        size: scale("size").optional(),
      }),
      events: ["select"],
      description:
        "menu of actions behind one trigger — row actions, page actions. `select` fires with the chosen item's value.",
      meta: { group: "interactive" },
    },
    link: {
      props: z.object({
        label: bound,
        href: z.string(),
        external: z.boolean().optional(),
        icon: z.string().optional(),
        color: scale("color").optional(),
      }),
      events: ["click"],
      description: "hyperlink.",
      meta: { group: "interactive" },
    },
    select: {
      props: z.object({
        ...fieldProps,
        value: z.union([z.string(), z.array(z.string())]).optional(),
        options: optionList,
        placeholder: z.string().optional(),
        icon: z.string().optional(),
        multiple: z.boolean().optional(),
        searchable: z.boolean().optional(),
        size: scale("size").optional(),
      }),
      events: ["change"],
      description:
        "dropdown. Bind `value` with $bindState and point a dataset filter at the same path to make it re-query the server.",
      meta: { group: "interactive", bindable: ["value"] },
    },
    input: {
      props: z.object({
        ...fieldProps,
        value: z.string().optional(),
        placeholder: z.string().optional(),
        icon: z.string().optional(),
        size: scale("size").optional(),
      }),
      events: ["change"],
      description: "single-line text box — search fields, lookups.",
      meta: { group: "interactive", bindable: ["value"] },
    },
    textarea: {
      props: z.object({
        ...fieldProps,
        value: z.string().optional(),
        placeholder: z.string().optional(),
        rows: z.number().optional(),
        size: scale("size").optional(),
      }),
      events: ["change"],
      description: "multi-line text box.",
      meta: { group: "interactive", bindable: ["value"] },
    },
    number_input: {
      props: z.object({
        ...fieldProps,
        value: z.number().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
      }),
      events: ["change"],
      description: "numeric stepper.",
      meta: { group: "interactive", bindable: ["value"] },
    },
    checkbox: {
      props: z.object({
        checked: z.boolean().optional(),
        label: z.string().optional(),
      }),
      events: ["change"],
      description: "boolean checkbox.",
      meta: { group: "interactive", bindable: ["checked"] },
    },
    switch: {
      props: z.object({
        checked: z.boolean().optional(),
        label: z.string().optional(),
      }),
      events: ["change"],
      description: "on/off toggle.",
      meta: { group: "interactive", bindable: ["checked"] },
    },
    radio_group: {
      props: z.object({
        ...fieldProps,
        value: z.string().optional(),
        options: optionList,
        orientation: orientation.optional(),
      }),
      events: ["change"],
      description: "exclusive choice.",
      meta: { group: "interactive", bindable: ["value"] },
    },
    // No `presets` prop, deliberately. The picker ships the workspace's own
    // preset list and exposes no way to narrow it, so a `presets` here would be
    // a prop the agent is told about, spends tokens on, and that renders
    // nothing. It comes back the day the picker takes one.
    date_range: {
      props: z.object({
        ...fieldProps,
        value: z
          .object({ start: z.string().nullable(), end: z.string().nullable() })
          .optional(),
      }),
      events: ["change"],
      description:
        "period picker — pair it with a `between` filter reading the same state path.",
      notes: { value: "ISO dates; bind it with $bindState" },
      meta: { group: "interactive", bindable: ["value"] },
    },
    slider: {
      props: z.object({
        ...fieldProps,
        value: z.number().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
      }),
      events: ["change"],
      description: "range slider.",
      meta: { group: "interactive", bindable: ["value"] },
    },

    // ---------- charts ----------
    chart_bar: {
      props: z.object({
        ...chartProps,
        ...axisProps,
        stacked: z.boolean().optional(),
        horizontal: z.boolean().optional(),
      }),
      description: "categorical bars over an aggregate dataset.",
      notes: {
        ...chartNotes,
        ...axisNotes,
        horizontal: "applied automatically past 6 categories or long labels",
      },
      meta: chartMeta,
    },
    chart_line: {
      props: z.object({
        ...chartProps,
        ...axisProps,
        curve: z.enum(["linear", "smooth"]).optional(),
        markers: z.boolean().optional(),
      }),
      description: "time series — pair it with a `dateBucket` aggregate.",
      notes: { ...chartNotes, ...axisNotes },
      meta: chartMeta,
    },
    chart_area: {
      props: z.object({
        ...chartProps,
        ...axisProps,
        stacked: z.boolean().optional(),
        curve: z.enum(["linear", "smooth"]).optional(),
      }),
      description: "filled time series, stackable for composition over time.",
      notes: { ...chartNotes, ...axisNotes },
      meta: chartMeta,
    },
    chart_donut: {
      props: z.object({
        ...chartProps,
        label: z.string().optional(),
        value: z.string().optional(),
        centerLabel: z.string().optional(),
        centerValue: bound.optional(),
      }),
      description:
        "share-of-total ring. Six slices at most — past that a horizontal bar chart is read faster.",
      notes: { ...chartNotes, label: "category field", value: "metric field" },
      meta: chartMeta,
    },
  },

  actions: {
    // `setState` / `pushState` / `removeState` are the schema's built-ins and
    // need no entry here.
    toggleState: {
      params: z.object({ statePath: z.string() }),
      description: "Flip a boolean state value.",
    },
    resetState: {
      params: z.object({ statePath: z.string().optional() }),
      description:
        "Restore state to its initial value — one path, or all of them when omitted.",
    },
    refetch: {
      params: z.object({ dataset: z.string().optional() }),
      description:
        "Re-run one dataset against the server, or all of them when omitted.",
    },
    openUrl: {
      params: z.object({ url: z.string(), external: z.boolean().optional() }),
      description: "Navigate to a URL.",
    },
    copy: {
      params: z.object({ value: z.unknown() }),
      description: "Copy a value to the viewer's clipboard.",
    },
    run: {
      params: z.object({ operation: z.string() }),
      description:
        "Run one of the definition's operations — a write into a connected app. Names an operations[] id; the server owns the action, connection and arguments.",
    },
  },
});

export type PagesCatalog = typeof pagesCatalog;

/**
 * Props every element accepts, whatever its type — where it sits in a grid and
 * how much room it gives itself.
 *
 * Outside the component schemas on purpose: merging them into all 48 would
 * print them 48 times in the prompt. The preamble states them once, and
 * `validatePageProps` merges them back in.
 */
export const COMMON_PROPS = z.object({
  span: scale("span").optional(),
  pad: scale("pad").optional(),
  grow: z.boolean().optional(),
});

/**
 * Per-type prop validation — what `catalog.validate()` cannot do (see
 * `core/props.ts`). Built once at module load.
 */
export const validatePageProps = createPropValidator(
  pagesCatalog.data.components,
  COMMON_PROPS,
  ["span"],
);

/** Every component a page element may name. */
export const PAGE_COMPONENT_TYPES: readonly string[] =
  pagesCatalog.componentNames;

/**
 * What a validator needs to know about a component beyond its props.
 *
 * `meta` is declared `s.any()` — the library's catalog shape has no room for
 * these facts — so it is narrowed ONCE here rather than at each call site. The
 * catalog's invariant tests already pin every listed prop to a real one.
 */
export interface PageComponentFacts {
  /** `layout` | `display` | `interactive` | `chart`. */
  group: string;
  acceptsChildren: boolean;
  /** Events it fires — anything else in `on` is dead weight. */
  events: readonly string[];
  /** Props naming one of the page's datasets by id. */
  datasetProps: readonly string[];
  /** Props meant to carry a two-way `$bindState`. */
  bindable: readonly string[];
}

const stringAt = (source: unknown, key: string): string => {
  if (typeof source !== "object" || source === null) return "";
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : "";
};

const stringsAt = (source: unknown, key: string): readonly string[] => {
  if (typeof source !== "object" || source === null) return [];
  const value: unknown = Reflect.get(source, key);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const FACTS_BY_TYPE = new Map<string, PageComponentFacts>(
  Object.entries(pagesCatalog.data.components).map(([type, entry]) => [
    type,
    {
      group: stringAt(entry.meta, "group"),
      // `slots` / `events` are declared only where they say something, so the
      // entry union does not carry them everywhere — read, not accessed.
      acceptsChildren: stringsAt(entry, "slots").includes("default"),
      events: stringsAt(entry, "events"),
      datasetProps: stringsAt(entry.meta, "datasetProps"),
      bindable: stringsAt(entry.meta, "bindable"),
    },
  ]),
);

export const pageComponentFacts = (
  type: string,
): PageComponentFacts | undefined => FACTS_BY_TYPE.get(type);

/**
 * What the RENDERER needs per prop, which neither the zod nor `meta` gives up
 * on its own: whether `{ base, sm, md, lg }` is accepted, and the closed set a
 * resolved binding must land in.
 *
 * Both are already encoded — one in `meta.responsive`, one in the zod enum —
 * but reading a zod schema at render time is exactly the kind of knowledge
 * that ends up reimplemented, slightly differently, on the other side of the
 * contract. It is derived ONCE here, and the renderer consumes plain data.
 */
export interface PagePropSpec {
  responsive: boolean;
  /** Present only for a closed enum — a binding landing outside it is reported. */
  values?: readonly string[];
}

const unwrapZod = (schema: z.ZodType): z.ZodType => {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    const inner: unknown = current.unwrap();
    if (!(inner instanceof z.ZodType)) return current;
    current = inner;
  }
  return current;
};

const specsOf = (
  props: z.ZodType,
  responsive: readonly string[],
): Record<string, PagePropSpec> => {
  const specs: Record<string, PagePropSpec> = {};
  for (const [name, schema] of Object.entries(shapeOf(props))) {
    const base = unwrapZod(schema);
    const values =
      base instanceof z.ZodEnum
        ? Object.values(base.enum).filter(
            (value): value is string => typeof value === "string",
          )
        : undefined;
    specs[name] = {
      responsive: responsive.includes(name),
      ...(values ? { values } : {}),
    };
  }
  return specs;
};

/** `span` / `pad` / `grow`, merged into every component — `span` is responsive. */
const COMMON_SPECS = specsOf(COMMON_PROPS, ["span"]);

const SPECS_BY_TYPE = new Map<string, Record<string, PagePropSpec>>(
  Object.entries(pagesCatalog.data.components).map(([type, entry]) => [
    type,
    {
      ...COMMON_SPECS,
      ...specsOf(entry.props, stringsAt(entry.meta, "responsive")),
    },
  ]),
);

export const pagePropSpecs = (type: string): Record<string, PagePropSpec> =>
  SPECS_BY_TYPE.get(type) ?? {};

/**
 * Every action an element's `on` or `watch` may name — the runtime's built-ins
 * plus this catalog's own. `actionNames` covers only the latter, and an agent
 * that cannot name `setState` cannot make a control do anything.
 */
export const PAGE_ACTION_NAMES: readonly string[] = [
  ...BUILT_IN_ACTIONS.map((action) => action.name),
  ...pagesCatalog.actionNames,
];

// ==================== //
// PROMPT               //
// ==================== //

/**
 * What a component listing cannot say: what a page IS, and the conventions
 * that repeat across components. Printed once, above the list.
 *
 * Design-time guidance — how to choose a layout, when a page beats an answer —
 * belongs to the `building-pages` skill, not here.
 */
const PAGES_PREAMBLE = [
  "A page is a data-bound document rendered with no model in the loop. It stores the QUESTION, never the answer: its datasets re-run on every view, so a page written today shows tomorrow's numbers tomorrow.",
  "",
  "Shape: `{ root, elements }`. `elements` is a flat map keyed by element id; nesting is expressed by an element's `children` naming other keys. `visible`, `on`, `repeat` and `watch` are fields on the element, never inside `props`. The whole page lives in that map — datasets alone render nothing:",
  "",
  // This example wrote `"span"` as a SIBLING of `props` for months. It is a
  // prop, `PageElementSchema` strips unknown element keys, and so every span
  // the example taught was deleted between the tool call and the store —
  // silently, and a 12-column grid then placed the element in one column.
  // The schema now lifts the sibling form back into `props`; this shows the
  // real home so nothing depends on that rescue.
  '```json\n{ "root": "page", "elements": {\n  "page":  { "type": "grid", "props": { "cols": "12" }, "children": ["title", "total", "trend"] },\n  "title": { "type": "heading", "props": { "text": "Sales", "level": 1, "span": "full" } },\n  "total": { "type": "stat", "props": { "label": "Revenue", "value": { "$": "data.kpi[0].amount" }, "format": "money", "currency": "EUR", "span": "4" } },\n  "trend": { "type": "chart_line", "props": { "dataset": "monthly", "x": "group", "y": ["amount"], "caption": "Revenue by month", "span": "8" } }\n} }\n```',
  "",
  "Conventions across every component below:",
  // `span` and `pad` are spelled out rather than written `@span` / `@pad`:
  // the scale table only lists what a COMPONENT references, and these three
  // are merged into every component. Spelling them here also carries the
  // quoting rule and the 12-column default.
  '- Every component also takes `span` ("1" … "12" or "full" — quoted, and responsive), `pad` (the @gap steps) and `grow` (boolean) — its placement in a grid and its own spacing. In a 12-column grid a child with no `span` takes the whole row.',
  "- A responsive prop takes `{ base, sm, md, lg }` in place of a single value; the components that accept one say so.",
  "- An `icon` prop takes a lucide name, bare or `i-lucide-` prefixed.",
  "- A `dataset` prop names one of the page's datasets by id.",
  "- `format` renders a value in the viewer's locale; `money` reads the `currency` beside it (ISO code).",
  // Hoisted out of the four chart entries, where the identical sentence was
  // printed three or four times each — roughly 1.2 KB of the catalog restating
  // itself. Same doctrine as `span`/`pad` above: a convention that holds across
  // a group is printed once.
  "- Charts: `caption` is one line under the title saying what is plotted (derived from the metric labels when absent); `legend` appears from 2 series onwards. On the cartesian three (bar/line/area), `x` is the category or time field — an aggregate dataset returns its grouping column as `group` — `y` is one metric name or a list of them, and `series` names the column whose VALUES become the series (required when the dataset has seriesBy).",
].join("\n");

/**
 * The agent-facing catalog. Served on demand — it is too large to sit in the
 * system prompt, and only a turn that builds a page needs it.
 */
export const pagesCatalogPrompt = (): string =>
  pagesCatalog.prompt({ system: PAGES_PREAMBLE });
