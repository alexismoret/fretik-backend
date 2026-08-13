import {
  PAGE_ACTION_NAMES,
  PAGE_COMPONENT_TYPES,
} from "@fretik/render/catalogs/pages";
import {
  MAX_EXPRESSION_CHARS,
  bindingSchema,
  isBinding,
  type Binding,
} from "@fretik/render/core/binding";
import { z } from "zod";
import { dateRangeFilterValueSchema, recordFilterOpSchema } from "./ontology";

/**
 * Page definition — a data-bound UI document the agent authors and the
 * frontend renders deterministically. NO LLM runs at view time: everything a
 * page does at runtime is expressed here as data (an element tree, JSONata
 * expressions, declarative actions, dataset descriptors).
 *
 * Kept db-free (pure Zod, like `schemas/workflow-forms.ts`): imported by
 * `db/schema/pages.ts` (type-only), the API boundary and the `managePage` tool.
 *
 * WHAT LIVES WHERE — the split this file's shape depends on:
 *
 * - The COMPONENT vocabulary (which types exist, which props each takes, which
 *   events it fires) belongs to `@fretik/render`'s pages catalog. One source
 *   feeds the agent prompt, the prop validator and the frontend registry, so
 *   the contract cannot drift from the renderer. The hand-written mirror this
 *   replaces drifted once already.
 * - The DATA contract — datasets, variables, filters, theme — belongs here,
 *   because it is bound to the ontology and to the query executor, neither of
 *   which the render package may depend on.
 *
 * Three deliberate design choices:
 *
 * 1. A FLAT element map, not a nested tree. Nesting is expressed by an
 *    element's `children` naming other keys, which is what makes an edit
 *    addressable: changing one card is one entry, not a re-send of the whole
 *    document. It is also `@json-render/vue`'s own shape, so the renderer
 *    walks the stored spec directly.
 * 2. `props` is an open JSON bag, NOT a per-type discriminated union. Which
 *    props a type accepts lives in the catalog, and `sanitizePageDefinition`
 *    drops off-catalog props with a warning. A 48-branch union would be
 *    enormous in the tool schema and would turn one bad prop into a hard turn
 *    failure.
 * 3. Styling is a CLOSED set of design-system tokens, never free CSS. The
 *    renderer maps prop values onto pre-compiled Tailwind classes (arbitrary
 *    runtime classes cannot work: Tailwind compiles at build time), which is
 *    also what keeps generated pages visually coherent.
 *
 * WRITE validation is LENIENT (a half-built draft saves: no root, dangling
 * refs). COMPLETENESS is enforced at publish (`pagePublishError`) — the same
 * split as `workflowFormActivationError`.
 */

// ==================== //
// LIMITS               //
// ==================== //

export const PAGE_LIMITS = {
  /** Elements reachable from the root. */
  maxElements: 400,
  maxDepth: 12,
  maxDatasets: 24,
  maxVariables: 24,
  maxFilters: 20,
  maxMetrics: 4,
  /** Server-side row ceiling for one `objects` dataset. */
  maxRows: 2000,
  /**
   * Runtime pagination, for a table that walks a type the page never holds in
   * full. `maxRows` bounds ONE response; these bound how far a viewer may walk
   * through the rest of them.
   *
   * ONE bound does the real work: the OFFSET. `page × pageSize` is what
   * Postgres skips before returning anything, and skipping is linear no matter
   * how good the index is. 50 000 stays sub-100 ms on the indexes P1 builds;
   * past that a viewer is not reading a table, and the honest answer is a
   * filter. The source clamps to it and echoes back the page it actually read.
   *
   * `maxPageIndex` is therefore a sanity bound, not a second policy — it is the
   * largest index that can be valid at ANY page size (offset ceiling at a page
   * size of one). It was 1 000, which quietly contradicted the offset rule:
   * 25 055 rows at 25 per page is 1 003 pages, all of them within the offset
   * ceiling, and clicking "last page" 400'd. Two bounds on the same thing is
   * how that happens; there is one now, and this only rejects the absurd.
   */
  maxPageIndex: 50_000,
  maxPageSize: 200,
  maxOffset: 50_000,
  /** `inline` dataset payload, measured on the JSON string. */
  maxInlineBytes: 200_000,
  maxExpressionChars: MAX_EXPRESSION_CHARS,
  maxTransformChars: 20_000,
  maxChildren: 100,
  /** A `table_cell` subtree renders once PER ROW, so it is capped harder than
   * the document at large — and so is the page size of the table holding it. */
  maxCellElements: 8,
  maxCellDepth: 3,
  maxCellPageSize: 50,
  /**
   * How long an external dataset's upstream answer may be reused, seconds.
   * The floor exists because a page renders far more often than a third party
   * wants to be called; the ceiling because past 15 minutes the data is not
   * "live" and belongs in an object type.
   */
  minExternalTtlSeconds: 15,
  maxExternalTtlSeconds: 900,
  defaultExternalTtlSeconds: 60,
  /** Bounds for a page's own auto-refresh loop (`autoRefreshSeconds`). */
  minAutoRefreshSeconds: 15,
  maxAutoRefreshSeconds: 3600,
  /** Declared write/read operations one page may run. */
  maxOperations: 16,
} as const;

/**
 * Identifier for datasets, variables, metrics and filter keys.
 *
 * Deliberately narrower than an element key: these names are read back inside
 * JSONata (`data.sales`, `state.month`), where a hyphen would parse as
 * subtraction and silently yield nothing.
 */
const PAGE_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const pageKeySchema = z
  .string()
  .regex(
    PAGE_KEY_RE,
    "key must be 1-60 chars: a-z, 0-9 or _, starting with a letter",
  );

/**
 * Identifier for one element of the spec. Hyphens and capitals are allowed —
 * an element key is a map key and nothing else reads it, so `kpi-total` is
 * fine here while it would break a JSONata reference.
 */
const PAGE_ELEMENT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/;
const pageElementKeySchema = z
  .string()
  .regex(
    PAGE_ELEMENT_KEY_RE,
    "element key must be 1-60 chars: letters, digits, _ or -, starting with a letter",
  );

// ==================== //
// VALUES & BINDINGS    //
// ==================== //

/**
 * Any JSON value that may appear in `props`, dataset rows, or action
 * arguments. A binding is structurally just `{ "$": "<jsonata>" }` — it needs
 * no separate branch here; `isPageBinding` recognises it at render time.
 */
export type PageValue =
  string | number | boolean | null | PageValue[] | { [key: string]: PageValue };

/**
 * ACYCLIC on purpose. The obvious spelling is `z.lazy(() => … pageValueSchema
 * …)`, and it was — but this schema is the leaf of every `props`, `rows`,
 * `initial`, `visible` and action param, so `managePage`'s tool schema carried
 * a self-referencing `$defs` entry that reached the provider. Measured
 * 2026-08-09 on `deepseek-v4-flash-0731`, same prompt, 3 runs each: Together
 * answered `400 — tool schema contains a circular reference` on EVERY call,
 * and flattening the cycle took it to a working page.
 *
 * Nothing is lost. The recursive form validated "is this JSON", and the value
 * always arrives through `JSON.parse` (an HTTP body, a tool call's arguments),
 * so that was a tautology; the containers below stay unconstrained inside
 * instead of being walked to the bottom.
 *
 * It also makes the tool schema far smaller: with `reused: "inline"` — what the
 * AI SDK asks for — the recursive union was expanded in full at every `props`,
 * `rows`, `visible` and action-param position.
 *
 * The RECURSION MOVES TO THE PREDICATE, where it costs nothing: `isPageValue`
 * walks the value in plain TypeScript, so the runtime check is if anything
 * stricter than the union it replaces (that union could not reject a function
 * nested inside an array), while `refine`'s type guard keeps the declared
 * `ZodType<PageValue>` and JSON Schema renders one flat `{}` + description.
 *
 * Three other spellings were tried and rejected, in order: `z.json()` and a
 * plain `z.lazy` re-introduce `$ref: "#"`; `z.custom` is unrepresentable in
 * JSON Schema (the AI SDK converts without `unrepresentable: "any"`, so it
 * throws at boot); dropping the annotation and letting the containers infer
 * `unknown` widens `PageDefinition` through every package that mirrors it — 12
 * type errors in this package alone, each wanting an `as` cast.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPageValue = (value: unknown): value is PageValue => {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPageValue);
  if (isPlainObject(value)) return Object.values(value).every(isPageValue);
  return false;
};

export const pageValueSchema: z.ZodType<PageValue> = z
  .unknown()
  .refine(isPageValue, { message: "expected a JSON value" })
  .meta({
    description:
      "Any JSON value: string, number, boolean, null, array or object.",
  });

/**
 * A reactive binding: a JSONata expression evaluated against
 * `{ state, data, item, index }`. Usable as ANY prop value, as a filter
 * value, as an action argument, and as an element's `visible` condition.
 *
 * Defined in `@fretik/render` and re-exported here, because it is the same
 * object the catalog documents to the agent and the frontend resolves at
 * render time. Two declarations of one shape is exactly the drift this
 * refonte removed.
 */
export const PageBindingSchema = bindingSchema;
export type PageBinding = Binding;

/** Structural test: is this prop value a binding rather than a literal? */
export const isPageBinding: (value: unknown) => value is PageBinding =
  isBinding;

/**
 * Visit every binding buried anywhere inside a value.
 *
 * Props nest — a chart's `columns`, a stat's `compare`, an action's params —
 * and a binding is just as live three levels down as at the top. Both the
 * sanitizer (syntax) and the dry-run (evaluation against real rows) need the
 * same reach, so the walk is declared once, beside the shape it walks.
 */
export const eachPageBinding = (
  value: PageValue,
  visit: (expression: string) => void,
): void => {
  if (isPageBinding(value)) {
    visit(value.$);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) eachPageBinding(entry, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) eachPageBinding(entry, visit);
  }
};

// ==================== //
// STATE                //
// ==================== //

export const PAGE_VARIABLE_TYPES = [
  "string",
  "number",
  "boolean",
  "string_list",
  "date_range",
  "json",
] as const;
export const pageVariableTypeSchema = z.enum(PAGE_VARIABLE_TYPES);
export type PageVariableType = z.infer<typeof pageVariableTypeSchema>;

/**
 * One piece of page state. Controls write it, expressions read it as
 * `state.<key>`, and dataset filters may bind to it — which is what makes a
 * period chip or a currency toggle re-query the server.
 *
 * These declarations ARE the state model: the renderer seeds its store from
 * them, so a control bound with `{ "$bindState": "/month" }` writes the
 * variable named `month` and nothing else. Declaring state here rather than in
 * the spec is what keeps it typed — a bare initial value cannot say that an
 * empty picker holds a date range.
 *
 * State is also the ONLY thing a viewer's browser may send back: the data
 * endpoint validates incoming values against these declarations and takes
 * every filter key, operator and object type from the stored definition. That
 * is what makes the public endpoint safe to expose anonymously.
 */
export const PageVariableSchema = z.object({
  key: pageKeySchema,
  type: pageVariableTypeSchema,
  /** Optional human label — filter controls fall back to it. */
  label: z.string().max(120).optional(),
  initial: pageValueSchema.optional(),
});
export type PageVariable = z.infer<typeof PageVariableSchema>;

// ==================== //
// DATASETS             //
// ==================== //

/**
 * Where rows come from. Objects were the first source, never the only one —
 * each kind is a resolver in `services/pages/sources/`, and adding one is a
 * new entry here plus a new file there, with no migration: datasets live in
 * the definition's JSONB.
 *
 * `external` is a live read from a connected app (MCP or manifest), resolved
 * server-side by `sources/external.ts` through a registered executor. It is
 * for SMALL, FRESH reads whose value is their recency — an inbox, today's
 * orders. Volume, history and anything published stay on the workflow → object
 * type path: a third party cannot be filtered, grouped or indexed the way an
 * object type can.
 *
 * A Drive spreadsheet is deliberately NOT a kind. A document's bytes cannot be
 * replaced (`updateDocument` changes its name and folder, nothing else), so a
 * dataset pointed at one would return the same rows forever — the freshness
 * profile of `inline`, at the price of parsing the workbook on every view
 * (measured: 173 ms and +79 MB for 2 000 rows of a 100 000-row file), for ever,
 * including on the public anonymous route. Small tables belong in `inline`,
 * paid once at authoring; anything large or meant to stay live belongs in an
 * object type, where the query engine already is.
 */
export const PAGE_DATASET_KINDS = [
  "inline",
  "objects",
  "transform",
  "external",
] as const;
export const pageDatasetKindSchema = z.enum(PAGE_DATASET_KINDS);
export type PageDatasetKind = z.infer<typeof pageDatasetKindSchema>;

export const PAGE_AGGREGATE_FNS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
] as const;
export const pageAggregateFnSchema = z.enum(PAGE_AGGREGATE_FNS);
export type PageAggregateFn = z.infer<typeof pageAggregateFnSchema>;

export const PAGE_DATE_BUCKETS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export const pageDateBucketSchema = z.enum(PAGE_DATE_BUCKETS);
export type PageDateBucket = z.infer<typeof pageDateBucketSchema>;

/**
 * A transform is JavaScript. One language, and it is the one the model writes
 * best.
 *
 * It used to be JSONata, and the failure was measured rather than assumed:
 * across two conversations, 14 of 30 generated transforms produced a warning,
 * while the one-line BINDINGS — the other place JSONata is used — failed once
 * in thirty. The difference is length. A binding is a dotted path with a bit of
 * arithmetic; a transform is a program, and JSONata is a language the model has
 * seen a thousandth as much of as JavaScript.
 *
 * Bindings keep JSONata deliberately: they also run in the BROWSER, on reactive
 * state, where a WASM interpreter would cost half a megabyte and one evaluation
 * per prop per row, and raw JavaScript would be same-origin — the stored-XSS
 * hole this whole design avoids.
 *
 * The value is kept as a one-member enum rather than deleted so a stored `lang`
 * still parses; nothing else may be written.
 */
export const PAGE_TRANSFORM_LANGS = ["js"] as const;
export const pageTransformLangSchema = z.enum(PAGE_TRANSFORM_LANGS);
export type PageTransformLang = z.infer<typeof pageTransformLangSchema>;

/**
 * A record filter whose value may be a binding — `{ key: "month", op: "eq",
 * value: { $: "state.month" } }` is how a control re-queries the server.
 * Operators are the record ones, re-validated server-side.
 */
export const PageFilterSchema = z.object({
  key: pageKeySchema,
  op: recordFilterOpSchema,
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      dateRangeFilterValueSchema,
      PageBindingSchema,
    ])
    .optional(),
});
export type PageFilter = z.infer<typeof PageFilterSchema>;

export const PageMetricSchema = z.object({
  /** Result key: rows come back as `{ group, <name>: value, … }`. */
  name: pageKeySchema,
  fn: pageAggregateFnSchema,
  /** Field to aggregate — omitted for `count`. */
  key: pageKeySchema.optional(),
  kind: z.enum(["number", "money"]).optional(),
  /**
   * Human label. ONE string that the renderer reuses as the legend entry, the
   * y-axis title, the chart caption, the table header and the tooltip row —
   * which is why writing it once removes five ways for a page to read like a
   * database dump ("nb", "m0").
   */
  label: z.string().max(80).optional(),
  /** Unit shown alongside the label: "kg", "days", "%", "THB". */
  unit: z.string().max(16).optional(),
});
export type PageMetric = z.infer<typeof PageMetricSchema>;

/**
 * Where a page's data comes from. Objects are ONE source, not the only one —
 * a page may be built entirely from `inline` data, and `transform` computes
 * whatever the base data cannot express (derived columns, set differences,
 * joins across datasets).
 */
export const PageDatasetSchema = z
  .object({
    id: pageKeySchema,
    kind: pageDatasetKindSchema,

    // --- inline: rows embedded in the definition ---
    /**
     * One OBJECT per row, keyed by column name — the shape every other source
     * returns, and the only shape `item.<key>`, a table column and a chart axis
     * can read. Left as a bare `pageValueSchema[]` this accepted an array of
     * arrays with a header row, which resolves to nothing everywhere it is
     * bound and reported no error (prod 2026-08-09).
     */
    rows: z.array(z.record(z.string(), pageValueSchema)).optional(),

    // --- objects: a live query over object records ---
    objectTypeId: z.uuid().optional(),
    /** `records` = rows; `aggregate` = grouped metrics. Defaults to records. */
    mode: z.enum(["records", "aggregate"]).optional(),
    filters: z.array(PageFilterSchema).max(PAGE_LIMITS.maxFilters).optional(),
    sortBy: z.string().max(80).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().positive().max(PAGE_LIMITS.maxRows).optional(),
    /** aggregate: field to group by (omit for a single scalar row). */
    groupBy: pageKeySchema.optional(),
    /** aggregate: bucket a date field instead of grouping on exact values. */
    dateBucket: pageDateBucketSchema.optional(),
    /** aggregate: optional second dimension (stacked bars, multi-series). */
    seriesBy: pageKeySchema.optional(),
    metrics: z.array(PageMetricSchema).max(PAGE_LIMITS.maxMetrics).optional(),

    // --- transform: compute over other datasets ---
    /** Dataset ids fed to the transform as `data.<id>`. */
    inputs: z.array(pageKeySchema).max(PAGE_LIMITS.maxDatasets).optional(),
    lang: pageTransformLangSchema.optional(),
    /** The body of `(data, state) => …` — it must `return` its rows. */
    code: z.string().max(PAGE_LIMITS.maxTransformChars).optional(),

    // --- external: a live read from a connected app ---
    // Every field lives in the DEFINITION, never in a request: a viewer cannot
    // name a connection or an operation any more than it can name an object
    // type. The connection itself is resolved AT VIEW TIME (see
    // `resolvePageConnection`): the viewer's own connection of the provider
    // first, the team's shared one second — the same page shows each member
    // their own data, which is why `providerKey` is the normal spelling and
    // `connectionId` is a deliberate pin.
    /** Pin ONE connection. Omit to resolve by provider for each viewer. */
    connectionId: z.uuid().optional(),
    /** Provider to resolve per viewer (their own connection, else the team's). */
    providerKey: z.string().max(80).optional(),
    /** The read operation to call on it (a tool or action name). */
    operation: z.string().max(120).optional(),
    /** Its arguments — literals, or bindings on page STATE (not data). */
    args: z.record(z.string(), pageValueSchema).optional(),
    /** Where the rows sit in the response, as a JSONata path. */
    resultPath: z.string().max(200).optional(),
    /** Upstream answer reuse window, seconds. Bounded by PAGE_LIMITS. */
    cacheTtlSeconds: z
      .number()
      .int()
      .min(PAGE_LIMITS.minExternalTtlSeconds)
      .max(PAGE_LIMITS.maxExternalTtlSeconds)
      .optional(),
  })
  .superRefine((ds, ctx) => {
    if (ds.kind === "objects" && !ds.objectTypeId) {
      ctx.addIssue({
        code: "custom",
        message: `dataset "${ds.id}": an objects dataset needs objectTypeId`,
        path: ["objectTypeId"],
      });
    }
    if (ds.kind === "transform" && !ds.code) {
      ctx.addIssue({
        code: "custom",
        message: `dataset "${ds.id}": a transform dataset needs code`,
        path: ["code"],
      });
    }
    if (ds.kind === "external") {
      if (!ds.operation) {
        ctx.addIssue({
          code: "custom",
          message: `dataset "${ds.id}": an external dataset needs operation`,
          path: ["operation"],
        });
      }
      if (!ds.connectionId && !ds.providerKey) {
        ctx.addIssue({
          code: "custom",
          message: `dataset "${ds.id}": an external dataset needs providerKey (or a pinned connectionId)`,
          path: ["providerKey"],
        });
      }
    }
  });
export type PageDataset = z.infer<typeof PageDatasetSchema>;

// ==================== //
// OPERATIONS (WRITES)  //
// ==================== //

/**
 * A named call INTO a connected app that a page may run — a form's submit, a
 * button that marks an order shipped. Datasets read; operations act.
 *
 * Declared at the top level rather than inline on the button, for the same
 * reason a dataset is: the STORED definition is the security boundary. A
 * viewer's browser sends an operation ID and values for the page's declared
 * VARIABLES — never an action name, never an argument template, never a
 * connection. The server re-evaluates the stored `args` against those values,
 * so the worst a forged request can do is pass a different string where a
 * string was already going to go.
 *
 * A FORM IS NOT A SEPARATE STATE MODEL. Its fields are ordinary variables
 * (`{ "$bindState": "/newOrderRef" }`), which is what gives them declared
 * types, coercion, and the one already-proven boundary; `form` is a layout
 * component that groups inputs and fires `submit`.
 *
 * `confirm` is not decoration: an action the app itself marks destructive is
 * REFUSED server-side unless the page declared one, so a "delete everything"
 * button cannot be one click by accident.
 */
export const PageOperationSchema = z.object({
  id: pageKeySchema,
  /** Pin ONE connection. Omit to resolve per viewer, like a dataset. */
  connectionId: z.uuid().optional(),
  providerKey: z.string().max(80).optional(),
  /** The action to call on it — a name from the app's own catalogue. */
  action: z.string().max(120),
  /** Argument template. Bindings read page state (`state.<variable>`). */
  args: z.record(z.string(), pageValueSchema).optional(),
  /** Ask before running. Required for anything the app marks destructive. */
  confirm: z
    .object({
      title: z.string().max(120),
      description: z.string().max(400).optional(),
    })
    .optional(),
  onSuccess: z
    .object({
      /** Datasets to re-run once it lands — how a page shows its own write. */
      refetch: z.array(pageKeySchema).max(PAGE_LIMITS.maxDatasets).optional(),
      /** Literal text; the page's own words, not an i18n key. */
      toast: z.string().max(200).optional(),
      /** Variables to clear — an entry form starting empty for the next one. */
      resetVariables: z
        .array(pageKeySchema)
        .max(PAGE_LIMITS.maxVariables)
        .optional(),
    })
    .optional(),
  onError: z.object({ toast: z.string().max(200).optional() }).optional(),
});
export type PageOperation = z.infer<typeof PageOperationSchema>;

// ==================== //
// ACTIONS              //
// ==================== //

/**
 * Every action an element may bind — the runtime's built-ins (`setState`,
 * `pushState`, `removeState`) plus the pages catalog's own. Sourced from the
 * catalog so the list the agent reads and the list the schema accepts are one
 * list.
 */
export const pageActionNameSchema = z.enum(PAGE_ACTION_NAMES);

/**
 * One bound action. `params` values may be bindings — `{ "$": "item.id" }` is
 * how a row click drills into the row it was fired from.
 *
 * Deliberately declarative — no JS in handlers: `setState` with a binding
 * covers filtering, drill-down and view switching, which is the whole
 * interactive surface of a dashboard. The stored shape is json-render's
 * `ActionBinding`, so the frontend's `ActionProvider` dispatches it as-is.
 */
export const PageActionSchema = z.object({
  action: pageActionNameSchema,
  params: z.record(z.string(), pageValueSchema).optional(),
  /** Suppress the browser's own handling (a link's navigation). */
  preventDefault: z.boolean().optional(),
});
export type PageAction = z.infer<typeof PageActionSchema>;

/** One event's handler: a single action, or several run in order. */
const pageActionBindingSchema = z.union([
  PageActionSchema,
  z.array(PageActionSchema).max(10),
]);

/**
 * WHICH events an element fires is a property of its component type, declared
 * in the catalog — so the key stays an open string here and
 * `sanitizePageDefinition` checks it against the type. A global enum would
 * accept `row_click` on a button.
 */
const pageEventMapSchema = z.record(z.string(), pageActionBindingSchema);

// ==================== //
// SPEC (FLAT ELEMENTS) //
// ==================== //

/** The component types the catalog defines. */
export const pageComponentTypeSchema = z.enum(PAGE_COMPONENT_TYPES);

/**
 * Render an element's children once per item of a state array.
 *
 * `statePath` is a JSON Pointer into the same state model the controls write:
 * `/data/<datasetId>` for a dataset's rows, `/<variable>` for a variable
 * holding a list. Inside, the item is read as `item.<field>` in a binding.
 */
export const PageRepeatSchema = z.object({
  statePath: z.string().max(200),
  /** Item field used as the list key — keeps rows stable across refetches. */
  key: z.string().max(80).optional(),
});
export type PageRepeat = z.infer<typeof PageRepeatSchema>;

/**
 * The three PLACEMENT props, and the reason this schema has a preprocess.
 *
 * `span` / `pad` / `grow` are ordinary props — the catalog declares them in
 * COMMON_PROPS and the renderer reads them off the resolved props, which is
 * what gives them bindings and responsive `{ base, md, lg }` forms for free.
 * But they READ like element metadata, they sit beside `visible` in the
 * catalog's conventions list, and the worked example in the preamble wrote
 * `"span": "full"` as a sibling of `props` for months. An object schema
 * strips unknown keys, so every one of them was deleted between the tool call
 * and the store — no warning, no polish, and a 12-column grid then placed the
 * element in ONE column. Measured 2026-08-10: not a single stored page had a
 * surviving span, and the page that shipped was unreadable past 1024px.
 *
 * So the sibling form is accepted and moved to where it belongs. This is the
 * sanitizer's coercion doctrine ("exactly one sensible reading") applied one
 * layer earlier, because by the time the sanitizer runs the key is gone. An
 * explicit prop always wins: re-running this on its own output changes
 * nothing.
 */
const PLACEMENT_PROPS = ["span", "pad", "grow"] as const;

const liftPlacementProps = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const misplaced = PLACEMENT_PROPS.filter(
    (name) => Reflect.get(value, name) !== undefined,
  );
  if (misplaced.length === 0) return value;

  const rest: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!PLACEMENT_PROPS.some((name) => name === key)) rest[key] = inner;
  }
  const declared: unknown = Reflect.get(value, "props");
  const props: Record<string, unknown> =
    typeof declared === "object" &&
    declared !== null &&
    !Array.isArray(declared)
      ? { ...declared }
      : {};
  for (const name of misplaced) {
    if (props[name] === undefined) props[name] = Reflect.get(value, name);
  }
  return { ...rest, props };
};

/**
 * One element of the page.
 *
 * `visible`, `on`, `repeat` and `watch` are SIBLINGS of `props`, never inside
 * it: the renderer reads them off the element, and one placed inside `props`
 * is ignored — an element that should have been conditional renders always.
 * It is the single most common structural mistake, which is why `autoFixSpec`
 * relocates it and the sanitizer reports it.
 *
 * `span` / `pad` / `grow` travel the OTHER way — see `liftPlacementProps`.
 */
export const PageElementSchema = z.preprocess(
  liftPlacementProps,
  z.object({
    type: pageComponentTypeSchema,
    /** Open bag; which props a type accepts comes from the catalog. Values may
     * be literals, bindings (`{ $: … }`), json-render's own dynamic forms
     * (`$state`, `$bindState`), or responsive objects (`{ base, md, lg }`)
     * where the catalog marks the prop responsive. */
    props: z.record(z.string(), pageValueSchema).optional(),
    /** Keys of child elements — a reference, not a nested element. */
    children: z
      .array(pageElementKeySchema)
      .max(PAGE_LIMITS.maxChildren)
      .optional(),
    /** Render condition: a binding, or a json-render state condition. */
    visible: pageValueSchema.optional(),
    /** Event name → the action(s) it runs. */
    on: pageEventMapSchema.optional(),
    repeat: PageRepeatSchema.optional(),
    /** State path → action(s) fired when the value at that path changes. */
    watch: pageEventMapSchema.optional(),
  }),
);
export type PageElement = z.infer<typeof PageElementSchema>;

/**
 * The renderable document: one root key and a flat map of elements.
 *
 * Byte-compatible with what `@json-render/vue`'s `Renderer` walks, so the
 * stored value is handed to it unchanged. The map is NOT keyed by a validating
 * schema on purpose — a malformed key is cosmetic, and rejecting the save
 * would cost a whole turn for something the sanitizer can report.
 */
export const PageSpecSchema = z.object({
  root: z.string().max(60),
  elements: z.record(z.string(), PageElementSchema),
});
export type PageSpec = z.infer<typeof PageSpecSchema>;

/**
 * An RFC 6902 edit to a stored page, rooted at the DEFINITION.
 *
 * Changing one card used to mean re-sending the whole document, and every
 * re-send is a chance to lose something that was fine. A path names exactly
 * what it touches: `/spec/elements/<key>/props/label`,
 * `/datasets/0/filters/0/value`, `/theme/accent`.
 *
 * Rooted at the definition, not at `spec`: the spec half was the only half with
 * an incremental channel, so changing a dataset filter forced a full rewrite —
 * the one move that loses elements. Every author of a page-shaped document
 * converges here (json-render ships `editModes: ["patch"]` as its refinement
 * default; v0 routes narrow edits through a separate quick-edit path).
 */
export const PageDefinitionPatchSchema = z
  .array(
    z.object({
      op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
      path: z.string().max(200),
      /** Required by add / replace / test. */
      value: pageValueSchema.optional(),
      /** Source path, required by move / copy. */
      from: z.string().max(200).optional(),
    }),
  )
  .max(50);
export type PageDefinitionPatch = z.infer<typeof PageDefinitionPatchSchema>;

/**
 * Page-wide look — three knobs, each one a design-system lever rather than
 * free CSS:
 *
 * - `accent` re-points `--ui-primary` for the page subtree, so every Nuxt UI
 *   component below keeps its native variants and only changes hue;
 * - `radius` re-points `--ui-radius`, which every `rounded-*` utility in the
 *   design system is computed from;
 * - `density` flows through `<UTheme :props>`, setting default sizes on the
 *   descendant components instead of hand-tuning padding per element.
 *
 * Deliberately no chart palette: a categorical palette must pass the `dataviz`
 * validator, and an unvalidated alternate would ship colour-blind collisions.
 */
export const PageThemeSchema = z.object({
  /** Any `color` token — semantic or Tailwind hue. */
  accent: z.string().max(24).optional(),
  density: z.enum(["compact", "default", "comfortable"]).optional(),
  radius: z.enum(["none", "sm", "md", "lg", "xl"]).optional(),
});
export type PageTheme = z.infer<typeof PageThemeSchema>;

/**
 * The whole stored page. `version` is a MIGRATION HANDLE, not decoration: the
 * definition lives in a jsonb column, and a format change has to be
 * recognisable without guessing at the shape. v1 was a nested `root: PageNode[]`
 * tree with its own descriptor catalog; v2 is the flat spec above.
 */
export const PageDefinitionSchema = z.object({
  version: z.literal(2),
  variables: z
    .array(PageVariableSchema)
    .max(PAGE_LIMITS.maxVariables)
    .default([]),
  datasets: z.array(PageDatasetSchema).max(PAGE_LIMITS.maxDatasets).default([]),
  operations: z
    .array(PageOperationSchema)
    .max(PAGE_LIMITS.maxOperations)
    .default([]),
  theme: PageThemeSchema.optional(),
  /**
   * Re-query the page's datasets every N seconds while it is open — the knob
   * that makes an inbox or an order board feel live. The floor keeps a page
   * from polling a third party faster than a human reads; viewers can always
   * refresh by hand.
   */
  autoRefreshSeconds: z
    .number()
    .int()
    .min(PAGE_LIMITS.minAutoRefreshSeconds)
    .max(PAGE_LIMITS.maxAutoRefreshSeconds)
    .optional(),
  /**
   * REQUIRED, and deliberately not defaulted. A `.default({ root: "",
   * elements: {} })` here reached the model as `"default": {"root": "",
   * "elements": {}}` in the tool's JSON Schema — the schema itself telling it
   * that a page with no elements is an ordinary value — and silently
   * manufactured a blank page whenever `spec` was omitted. An empty page is a
   * legitimate DRAFT, so that default belongs to `CreatePageSchema`, which is
   * where a caller says "start me a page", not to the document itself.
   */
  spec: PageSpecSchema,
});
export type PageDefinition = z.infer<typeof PageDefinitionSchema>;

/**
 * What an AUTHOR may send: the definition with `spec` optional, so a page can
 * be opened from its datasets alone and grown one `patch` op at a time.
 *
 * Not a convenience — a portability fix, measured 2026-08-10 by replaying the
 * production request against each upstream in the pool. One of them writes
 * `spec.elements` correctly 0 times in 28 through the nested `definition` path,
 * and 15 times in 16 through `patch`, with the same element count as the
 * upstreams that succeed. Payload size, context size, reasoning budget,
 * property order and schema floors all measured NO effect; the argument PATH is
 * the whole variable. A build that never has to emit a deep nested map in one
 * call is the shape every upstream can serve.
 *
 * Storage keeps `spec` REQUIRED (`PageDefinitionSchema`): a stored page without
 * one would reach the renderer. Omitting it here means "opened, not yet drawn",
 * and the tool answers with the directive that says so.
 */
export const PageDraftDefinitionSchema = PageDefinitionSchema.partial({
  spec: true,
});
export type PageDraftDefinition = z.infer<typeof PageDraftDefinitionSchema>;

export const EMPTY_PAGE_DEFINITION: PageDefinition = {
  version: 2,
  variables: [],
  datasets: [],
  operations: [],
  spec: { root: "", elements: {} },
};

// ==================== //
// SPEC TRAVERSAL       //
// ==================== //

export interface PageSpecStats {
  /** Distinct elements reachable from the root. */
  count: number;
  /** Longest path from the root, the root counting as 1. */
  depth: number;
  /** Elements whose subtree points back at them. */
  cycles: string[];
}

/**
 * Walk the spec from its root, counting what actually renders.
 *
 * CYCLES ARE THE POINT. A nested tree could not close a loop; a flat map can —
 * `a` lists `b` as a child and `b` lists `a` — and the renderer would recurse
 * until the browser's stack gives out. json-render's own `validateSpec` does
 * not look for it (its walk terminates, its renderer does not), so this is the
 * only place the shape is checked before a page is served.
 *
 * Unreachable and dangling keys are NOT reported here: `validateSpec` already
 * names both, and reporting them twice would put two different sentences about
 * one mistake in front of the agent.
 */
export const pageSpecStats = (spec: PageSpec): PageSpecStats => {
  const cycles = new Set<string>();
  /** Deepest position each key has been reached at — bounds the revisits a
   *  shared element would otherwise multiply. */
  const bestDepth = new Map<string, number>();
  const onPath = new Set<string>();
  let deepest = 0;

  const walk = (key: string, depth: number): void => {
    const element = spec.elements[key];
    if (!element) return;
    if (onPath.has(key)) {
      cycles.add(key);
      return;
    }
    const seen = bestDepth.get(key);
    if (seen !== undefined && seen >= depth) return;
    bestDepth.set(key, depth);
    if (depth > deepest) deepest = depth;

    onPath.add(key);
    for (const child of element.children ?? []) walk(child, depth + 1);
    onPath.delete(key);
  };

  walk(spec.root, 1);
  return { count: bestDepth.size, depth: deepest, cycles: [...cycles] };
};

// ==================== //
// BLANK-PAGE GATE      //
// ==================== //

/**
 * The one page defect a warning cannot carry: a spec whose root resolves to no
 * element renders literally nothing, so accepting the write is worse than
 * refusing it — the caller is told the page was saved and the user opens a
 * blank screen.
 *
 * Returns an agent-directive sentence, or null when something will render.
 * Everything else about a spec stays sanitize-and-warn: an off-catalog prop is
 * a best guess worth keeping the turn for, an empty document is not.
 *
 * Deliberately NOT enforced by `createPage` / `updatePage`: the HTTP layer
 * saves drafts, and `EMPTY_PAGE_DEFINITION` is a legitimate starting state.
 * The gate belongs at the callers that claim to have authored a page.
 */
export const pageBlankError = (spec: PageSpec): string | null => {
  if (Object.keys(spec.elements).length === 0) {
    return "spec.elements is empty, so the page renders nothing. Write one entry per element, keyed by its own id.";
  }
  if (!spec.root) {
    return `spec.root is empty, so the page renders nothing. Point it at the element that holds the others — one of: ${Object.keys(spec.elements).slice(0, 8).join(", ")}.`;
  }
  if (!spec.elements[spec.root]) {
    return `spec.root is "${spec.root}" but spec.elements has no such key, so the page renders nothing. Point root at one of: ${Object.keys(spec.elements).slice(0, 8).join(", ")}.`;
  }
  return null;
};

// ==================== //
// PUBLISH GATE         //
// ==================== //

/**
 * COMPLETENESS gate, run at publish (a draft page saves incomplete). Returns
 * an error message, or null when the page is ready to serve publicly.
 */
export const pagePublishError = (definition: PageDefinition): string | null => {
  const { spec } = definition;
  if (pageBlankError(spec)) {
    return "The page needs a root element to publish.";
  }
  const { count, depth, cycles } = pageSpecStats(spec);
  const [cycle] = cycles;
  if (cycle !== undefined) {
    return `Element "${cycle}" is inside its own subtree; the page would render forever.`;
  }
  if (count > PAGE_LIMITS.maxElements) {
    return `The page has ${count.toString()} elements; the ceiling is ${PAGE_LIMITS.maxElements.toString()}.`;
  }
  if (depth > PAGE_LIMITS.maxDepth) {
    return `The page nests ${depth.toString()} levels deep; the ceiling is ${PAGE_LIMITS.maxDepth.toString()}.`;
  }
  // Publishing turns a page into a link anyone can open. An external dataset
  // would then let an anonymous visitor cause a call to a third party ON THE
  // TEAM'S CREDENTIALS — metered, rate-limited, and capable of flipping the
  // connection to `error` for everyone. Refused at the publish gate rather
  // than at render, so the answer arrives while the author can still act on it.
  const external = definition.datasets.find(
    (dataset) => dataset.kind === "external",
  );
  if (external) {
    return `Dataset "${external.id}" reads a connected app, which a published page may not do — an anonymous visitor would be spending the team's credentials. Sync it into an object type with a workflow and query that instead.`;
  }
  // Same rule, one step stronger: an operation WRITES to a third party. A link
  // anyone can open must not carry one, whatever it is guarded by client-side.
  const [operation] = definition.operations;
  if (operation !== undefined) {
    return `Operation "${operation.id}" writes to a connected app, which a published page may not do — anyone with the link could run it on the team's credentials. Keep this page internal, or remove its operations.`;
  }
  return null;
};

// ==================== //
// AGENT: DATA CONTRACT //
// ==================== //

/**
 * The half of the page grammar the component catalog cannot describe: where
 * rows come from, what a viewer may change, and the page's own look.
 *
 * `@fretik/render` owns the component half (`pagesCatalogPrompt`) and knows
 * nothing of the ontology; this half is generated from the schema constants
 * right above it, so a new dataset kind or aggregate function reaches the
 * agent by existing. `managePage`'s `get_catalog` action serves the two
 * together — on demand, never in the cached system prompt.
 */
export const describePageDataContract = (): string =>
  [
    "## datasets",
    `kind=inline    → rows: [{ column: value }, …] embedded in the page (≤${Math.floor(PAGE_LIMITS.maxInlineBytes / 1000).toString()}KB).`,
    "                 One object per row, keyed by column name — no header row.",
    "kind=objects   → objectTypeId + mode(records|aggregate) + filters/sortBy/limit,",
    `                 or groupBy/dateBucket(${PAGE_DATE_BUCKETS.join("|")})/seriesBy + metrics.`,
    `                 metric = { name, fn(${PAGE_AGGREGATE_FNS.join("|")}), key?, label, unit? }.`,
    "                 `key` is required by every fn except count.",
    "                 ALWAYS give a metric a `label`: it becomes the legend entry, the",
    "                 axis title, the column header and the tooltip row in one stroke.",
    "                 Filter values may bind to state → the server re-queries on change.",
    "                 An objects dataset also ships its FIELD TYPES, so tables, `field`",
    "                 and cells render selects as their own coloured badges with no work.",
    "mode=records reads a WINDOW of the type, not all of it. A table over one pages and",
    "sorts server-side, so `limit` is the page size (25–100) and the count it shows is",
    "the real total, however many millions sit behind it. Consequence: a column total",
    "would then be the total of one page — for a figure that always holds, add an",
    "aggregate dataset. Give a paginated table a dataset of its own; paging re-queries",
    "it, and anything else reading it would move under the reader.",
    "kind=transform → inputs:[datasetIds] + code. Computes what the query cannot:",
    "                 derived columns, ratios between datasets, set differences, joins.",
    "                 The code is the BODY of (data, state) => … in JAVASCRIPT: read",
    "                 `data.<inputId>`, read `state.<key>`, and `return` an array of rows",
    "                 (or one object). Plain JSON in, plain JSON out — no IO, no await,",
    "                 500 ms. It runs on results the query ALREADY reduced: never group or",
    "                 sum here, an aggregate dataset does that in SQL over every row.",
    "kind=external  → providerKey + operation (+ args, resultPath?, cacheTtlSeconds?).",
    "                 A live read from a connected app. Name the PROVIDER: each viewer",
    "                 then reads through their own connection, the team's otherwise.",
    "                 `connectionId` pins one account for everyone — only when they all",
    "                 must see that same account.",
    '                 args may bind to state (`{"$": "state.folder"}`), never to data.',
    "                 resultPath is a JSONata path to the rows inside the answer — run",
    "                 dry_run to see the real shape before writing it.",
    "A dataset's rows land in state at `/data/<id>`: that is the `statePath` a",
    "`repeat` names, and `data.<id>` is how a binding reads them.",
    "",
    "## state",
    `variables: [{ key, type(${PAGE_VARIABLE_TYPES.join("|")}), label?, initial? }]`,
    'Every variable is a state path: `month` is written by `{ "$bindState": "/month" }`',
    "on a control, read as `state.month` in a binding, and bound to by a dataset filter.",
    'An "all" chip is an option with value: "" — an empty value drops its filter.',
    "",
    "## operations (writes)",
    "operations: [{ id, providerKey, action, args?, confirm?, onSuccess?, onError? }]",
    "A write into a connected app, run by the `run` action: bind",
    '`{ "action": "run", "params": { "operation": "<id>" } }` to a button\'s `click`',
    "or a form's `submit`. Connections resolve per viewer, exactly as a dataset's do.",
    "args bind to state, so a form field IS a variable — no separate form model.",
    "confirm: { title, description? } asks before running, and is REQUIRED for any",
    "action the app marks destructive (the server refuses it otherwise).",
    "onSuccess: { refetch: [datasetIds], toast?, resetVariables? } — refetch is how the",
    "page shows its own write; resetVariables clears an entry form for the next one.",
    "A page with operations cannot be published: a public link must not write.",
    "",
    "## theme (page level, optional)",
    "theme: { accent(@color), density(@density), radius(none|sm|md|lg|xl) }",
    "Sets the page's own accent and rounding; density resizes every control below.",
    "autoRefreshSeconds (page level, ≥15) re-queries every dataset on a timer — for a",
    "board someone leaves open, not for a report.",
  ].join("\n");

// ==================== //
// API CONTRACT         //
// ==================== //

export const CreatePageSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).default(""),
  icon: z.string().max(60).optional(),
  color: z.string().max(20).optional(),
  /** NULL/omitted = team-shared; the caller's own id = private to them. */
  userId: z.uuid().nullable().optional(),
  definition: PageDefinitionSchema.default(EMPTY_PAGE_DEFINITION),
  sourceConversationId: z.uuid().optional(),
});
export type CreatePageInput = z.infer<typeof CreatePageSchema>;

export const UpdatePageSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().max(60).nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  userId: z.uuid().nullable().optional(),
  definition: PageDefinitionSchema.optional(),
});
export type UpdatePageInput = z.infer<typeof UpdatePageSchema>;

export const PageResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  userId: z.string().nullable(),
  definition: PageDefinitionSchema,
  publicToken: z.string().nullable(),
  publishedAt: z.date().nullable(),
  /** Ready-to-copy public URL; null while unpublished. */
  publicUrl: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PageResponse = z.infer<typeof PageResponseSchema>;

/** List rows omit the definition — a page list must not ship every tree. */
export const PageSummarySchema = PageResponseSchema.omit({
  definition: true,
}).extend({
  elementCount: z.number(),
  datasetCount: z.number(),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

/**
 * Data request. The viewer's browser may send NOTHING BUT variable values:
 * every filter key, operator and object type comes from the stored
 * definition. That asymmetry is what makes the same executor safe to expose on
 * the anonymous public route.
 */
/**
 * What a viewer may ask of ONE dataset at runtime: which window of it, in which
 * order. Nothing else.
 *
 * This is deliberately not a query language. There is no filter here, no object
 * type, no expression — those stay in the stored definition, which is what
 * keeps the same executor safe on the anonymous public route. Page and size are
 * bounded integers; `sortBy` is a NAME that the source resolves against the
 * dataset's own fields and drops if it does not know it, so it can never become
 * an identifier in a query.
 *
 * Only `objects` datasets in `records` mode read it — for an aggregate the
 * grouping IS the query, and for inline/transform rows the client already holds
 * everything.
 */
export const PageDatasetQuerySchema = z.object({
  /** 1-based, like the page numbers a viewer actually sees. */
  page: z.number().int().min(1).max(PAGE_LIMITS.maxPageIndex).optional(),
  pageSize: z.number().int().min(1).max(PAGE_LIMITS.maxPageSize).optional(),
  /** A field key, or `label` / `createdAt` / `updatedAt`. Unknown → ignored. */
  sortBy: z.string().max(80).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
export type PageDatasetQuery = z.infer<typeof PageDatasetQuerySchema>;

export const PageDataRequestSchema = z.object({
  variables: z.record(z.string(), pageValueSchema).default({}),
  /** Restrict execution to these dataset ids (a targeted refetch). */
  datasetIds: z.array(pageKeySchema).max(PAGE_LIMITS.maxDatasets).optional(),
  /** Per-dataset window and ordering. Ids the page does not declare are dropped. */
  queries: z.record(pageKeySchema, PageDatasetQuerySchema).optional(),
  /**
   * Skip the response cache — what the refresh button means.
   *
   * Honoured on the AUTHENTICATED route only. On the published route it would
   * be a switch any anonymous visitor could use to put the owner's database
   * back in front of a crowd.
   */
  fresh: z.boolean().optional(),
});
export type PageDataRequest = z.infer<typeof PageDataRequestSchema>;

/**
 * What the renderer needs to draw ONE field the way the whole workspace draws
 * it — a select as its own coloured badge, money in its currency, a rating as
 * stars, a relation as a chip with its target type's icon.
 *
 * Shipped with the DATA and not with the definition, deliberately: a published
 * page's definition is frozen at publish time, and an option's colour must not
 * be. It is also an explicit ALLOWLIST rather than the stored `FieldDefinition`
 * — that object carries formulas, permissions and internal ids that have no
 * business reaching an anonymous public page.
 */
export const PageFieldDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** A `FieldDefinitionType`, kept as a plain string so the renderer stays
   * decoupled from the ontology enum. */
  type: z.string(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        color: z.string().optional(),
        icon: z.string().optional(),
      }),
    )
    .optional(),
  currencyCode: z.string().optional(),
  /** number: display config that changes the SHAPE of the render. */
  numberFormat: z.string().optional(),
  precision: z.number().optional(),
  suffix: z.string().optional(),
  display: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** rating */
  ratingMax: z.number().optional(),
  ratingIcon: z.string().optional(),
  /** date: whether the value carries a time of day. */
  hasTime: z.boolean().optional(),
  /** unique_id */
  prefix: z.string().optional(),
  /** relation: the target type's own look, resolved server-side. */
  targetIcon: z.string().optional(),
  targetColor: z.string().optional(),
  /** The field the object type treats as its title. */
  isTitle: z.boolean().optional(),
  /**
   * Whether a table may order on this field — false for the computed ones
   * (`relation`, `rollup`), which have no stored column to sort. Shipped so the
   * renderer knows which headers to make clickable without duplicating the
   * ontology's rules in the browser.
   */
  sortable: z.boolean().optional(),
});
export type PageFieldDescriptor = z.infer<typeof PageFieldDescriptorSchema>;

export const PageDatasetResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    rows: z.array(pageValueSchema),
    truncated: z.boolean(),
    /**
     * Rows matching the dataset's filters, ignoring `limit` — the difference
     * between "25 rows" and "25 of 3 214 987". Only `objects`/`records`
     * datasets know it; a table without it can only paginate what it holds.
     */
    totalCount: z.number().int().nonnegative().optional(),
    /**
     * The window these rows came from — echoed back because the server clamps
     * what it was asked (offset ceiling, unknown sort key), and a paginator
     * that showed the REQUEST rather than the answer would lie about where the
     * viewer is.
     */
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
    /** The ordering actually applied, once resolved against the real fields. */
    sortBy: z.string().optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    /** Present for `objects` datasets — what makes cells render typed. */
    fields: z.array(PageFieldDescriptorSchema).optional(),
  }),
  /** The viewer's team has no grant on that object type — this block only. */
  z.object({ status: z.literal("forbidden") }),
  /**
   * An external dataset found no usable connection FOR THIS VIEWER — the page
   * itself is fine, so the frontend renders a "connect your account" prompt in
   * the dataset's place instead of an error.
   */
  z.object({
    status: z.literal("needs_connection"),
    providerKey: z.string(),
    /** Human name of the app, when a pinned connection told us. */
    displayName: z.string().optional(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type PageDatasetResult = z.infer<typeof PageDatasetResultSchema>;

export const PageDataResponseSchema = z.object({
  datasets: z.record(z.string(), PageDatasetResultSchema),
});
export type PageDataResponse = z.infer<typeof PageDataResponseSchema>;

/**
 * Running ONE declared operation. The same asymmetry as the data request, and
 * enforced by the same code: the browser names an operation the page declares
 * and supplies variable VALUES, while the action, the connection and the
 * argument template all come from the stored definition. `resolvePageState`
 * coerces those values against the declared types and drops everything else,
 * so a write reaches the app through exactly the boundary a read does.
 */
export const PageRunRequestSchema = z.object({
  operation: pageKeySchema,
  variables: z.record(z.string(), pageValueSchema).default({}),
});
export type PageRunRequest = z.infer<typeof PageRunRequestSchema>;

export const PageRunResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** What the app answered, narrowed to JSON and capped. */
    result: pageValueSchema.optional(),
  }),
  z.object({ status: z.literal("needs_connection"), providerKey: z.string() }),
  /** The action is disabled on that connection by its permission settings. */
  z.object({ status: z.literal("blocked"), message: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type PageRunResponse = z.infer<typeof PageRunResponseSchema>;

/** Access verdict for the public route — mirrors `PublicFormResponse`. */
export const PUBLIC_PAGE_ACCESS_VALUES = [
  "ready",
  "not_found",
  "login_required",
  "forbidden",
] as const;
export const publicPageAccessSchema = z.enum(PUBLIC_PAGE_ACCESS_VALUES);
export type PublicPageAccess = z.infer<typeof publicPageAccessSchema>;

export const PublicPageViewSchema = z.object({
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  definition: PageDefinitionSchema,
  organizationName: z.string(),
  organizationLogo: z.string().nullable(),
  teamName: z.string(),
});
export type PublicPageView = z.infer<typeof PublicPageViewSchema>;

export const PublicPageResponseSchema = z.object({
  access: publicPageAccessSchema,
  page: PublicPageViewSchema.optional(),
});
export type PublicPageResponse = z.infer<typeof PublicPageResponseSchema>;
