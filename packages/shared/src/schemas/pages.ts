import { z } from "zod";
import { dateRangeFilterValueSchema, recordFilterOpSchema } from "./ontology";

/**
 * Page definition — an agent-CODED UI document. The agent writes a complete
 * Vue SFC; the server compiles it at save time (`services/pages/compile.ts`);
 * the frontend renders the compiled module inside a sandboxed opaque-origin
 * iframe. NO LLM runs at view time.
 *
 * Kept db-free (pure Zod, like `schemas/workflow-forms.ts`): imported by
 * `db/schema/pages.ts` (type-only), the API boundary and the `managePage` tool.
 *
 * TWO HALVES, one boundary:
 *
 * - The DATA half — variables, datasets, operations — is declarative and
 *   server-enforced. `run-page-data.ts` accepts nothing from a viewer's
 *   browser but VALUES for declared variables; every filter key, operator,
 *   object type, connection and argument template comes from the stored
 *   definition. That asymmetry is what makes the same executor safe on the
 *   anonymous public route, and it is untouched by the code redesign.
 * - The PRESENTATION half is `code`: one Vue SFC, compiled server-side,
 *   reaching the data half only through the parent-mediated postMessage
 *   bridge. No expression language, no component catalog — the compiler and
 *   the sandbox are the contract.
 *
 * Dynamic values in the data half are `{ "var": "<variableKey>" }` references
 * — a filter value or an external arg points at a declared variable, the
 * server substitutes its current (type-coerced) value. A reference is data,
 * not code: nothing evaluates.
 */

// ==================== //
// LIMITS               //
// ==================== //

export const PAGE_LIMITS = {
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
   * size of one).
   */
  maxPageIndex: 50_000,
  maxPageSize: 200,
  maxOffset: 50_000,
  /** `inline` dataset payload, measured on the JSON string. */
  maxInlineBytes: 200_000,
  maxTransformChars: 20_000,
  /**
   * How long an external dataset's upstream answer may be reused, seconds.
   * The floor exists because a page renders far more often than a third party
   * wants to be called; the ceiling because past 15 minutes the data is not
   * "live" and belongs in an object type.
   */
  minExternalTtlSeconds: 15,
  maxExternalTtlSeconds: 900,
  defaultExternalTtlSeconds: 60,
  /** Declared write/read operations one page may run. */
  maxOperations: 16,

  /** The page's Vue SFC source, characters. */
  maxSourceChars: 120_000,
  /** Compiled module / stylesheet ceilings — a compile output past these is a bug, not a page. */
  maxCompiledJsChars: 400_000,
  maxCompiledCssChars: 100_000,
  /** Targeted source edits per update call. */
  maxEdits: 20,
  maxEditChars: 4_000,
} as const;

/**
 * Identifier for datasets, variables, metrics and filter keys.
 *
 * Narrow on purpose: these names are read back as PROPERTIES in JavaScript —
 * `data.sales` in a transform, `datasets.sales.rows` in the page code — where
 * a hyphen would force bracket syntax and a leading digit would not parse.
 */
const PAGE_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const pageKeySchema = z
  .string()
  .regex(
    PAGE_KEY_RE,
    "key must be 1-60 chars: a-z, 0-9 or _, starting with a letter",
  );

// ==================== //
// VALUES & VAR REFS    //
// ==================== //

/**
 * Any JSON value that may appear in dataset rows, variable initials, or
 * operation/external arguments.
 */
export type PageValue =
  string | number | boolean | null | PageValue[] | { [key: string]: PageValue };

/**
 * ACYCLIC on purpose. The obvious spelling is `z.lazy(() => … pageValueSchema
 * …)`, and it was — but this schema is the leaf of every `rows`, `initial`
 * and argument position, so `managePage`'s tool schema carried a
 * self-referencing `$defs` entry that reached the provider. Measured
 * 2026-08-09 on `deepseek-v4-flash-0731`: Together answered `400 — tool schema
 * contains a circular reference` on EVERY call, and flattening the cycle took
 * it to a working page.
 *
 * The RECURSION MOVES TO THE PREDICATE, where it costs nothing: `isPageValue`
 * walks the value in plain TypeScript, while `refine`'s type guard keeps the
 * declared `ZodType<PageValue>` and JSON Schema renders one flat `{}`.
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
 * A reference to a declared variable's CURRENT value: `{ "var": "month" }`.
 * Legal wherever a dynamic value is (a filter value, an external/operation
 * argument). The server substitutes the type-coerced value at request time —
 * a reference is data, never code.
 */
export const PageVarRefSchema = z.object({ var: pageKeySchema });
export type PageVarRef = z.infer<typeof PageVarRefSchema>;

/** Structural test: is this value a `{ var }` reference rather than a literal? */
export const isPageVarRef = (value: unknown): value is PageVarRef =>
  isPlainObject(value) &&
  typeof value["var"] === "string" &&
  Object.keys(value).length === 1;

/** Visit every `{ var }` reference buried anywhere inside a value — the
 * sanitizer checks each against the declared variables. */
export const eachPageVarRef = (
  value: PageValue,
  visit: (variableKey: string) => void,
): void => {
  if (isPageVarRef(value)) {
    visit(value.var);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) eachPageVarRef(entry, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) eachPageVarRef(entry, visit);
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
 * One piece of page state. The page CODE reads and writes these by sending
 * values with `fretik.data.query({ variables })`; dataset filters may
 * reference them — which is what makes a period chip or a status filter
 * re-query the server.
 *
 * State is also the ONLY thing a viewer's browser may send back: the data
 * endpoint validates incoming values against these declarations and takes
 * every filter key, operator and object type from the stored definition. That
 * is what makes the public endpoint safe to expose anonymously.
 */
export const PageVariableSchema = z.object({
  key: pageKeySchema,
  type: pageVariableTypeSchema,
  /** Optional human label. */
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
 * A transform is JavaScript, run in the server's QuickJS-WASM sandbox
 * (`lib/js-sandbox.ts`) — no IO, no host access, hard time/memory caps. One
 * language, and it is the one the model writes best.
 */
export const PAGE_TRANSFORM_LANGS = ["js"] as const;
export const pageTransformLangSchema = z.enum(PAGE_TRANSFORM_LANGS);
export type PageTransformLang = z.infer<typeof pageTransformLangSchema>;

/**
 * A record filter whose value may be a `{ var }` reference — `{ key: "stage",
 * op: "eq", value: { "var": "stage" } }` is how a page control re-queries the
 * server. Operators are the record ones, re-validated server-side.
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
      PageVarRefSchema,
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
  /** Human label — the page code renders it, so one good label beats five
   * cryptic result keys. */
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
     * returns. Left as a bare `pageValueSchema[]` this accepted an array of
     * arrays with a header row, which resolves to nothing everywhere it is
     * read and reported no error (prod 2026-08-09).
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
    /** Its arguments — literals, or `{ "var": "<key>" }` references to page state. */
    args: z.record(z.string(), pageValueSchema).optional(),
    /**
     * Where the rows sit in the response: a dot path (`value.items`,
     * `data.messages[0].rows`). Plain property/index steps only — run dry_run
     * to see the real shape before writing it.
     */
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
 * Declared at the top level, for the same reason a dataset is: the STORED
 * definition is the security boundary. The page code calls
 * `fretik.ops.run("<id>", { variables })` through the bridge; the browser
 * sends an operation ID and values for the page's declared VARIABLES — never
 * an action name, never an argument template, never a connection. The server
 * re-resolves the stored `args` against those values, so the worst a forged
 * request can do is pass a different string where a string was already going
 * to go.
 *
 * `confirm` is not decoration: an action the app itself marks destructive is
 * REFUSED server-side unless the page declared one, and the PARENT shell (not
 * the sandboxed page) renders the confirmation — a "delete everything" button
 * cannot be one click, and the page code cannot fake the consent.
 */
export const PageOperationSchema = z.object({
  id: pageKeySchema,
  /** Pin ONE connection. Omit to resolve per viewer, like a dataset. */
  connectionId: z.uuid().optional(),
  providerKey: z.string().max(80).optional(),
  /** The action to call on it — a name from the app's own catalogue. */
  action: z.string().max(120),
  /** Argument template — literals, or `{ "var": "<key>" }` references to page state. */
  args: z.record(z.string(), pageValueSchema).optional(),
  /** Ask before running. Required for anything the app marks destructive. */
  confirm: z
    .object({
      title: z.string().max(120),
      description: z.string().max(400).optional(),
    })
    .optional(),
});
export type PageOperation = z.infer<typeof PageOperationSchema>;

// ==================== //
// THEME                //
// ==================== //

/** Tailwind hue names a page accent may re-point the primary scale to. */
export const PAGE_ACCENT_TOKENS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
] as const;

/**
 * Page-wide look. `accent` re-points the primary color scale for the page's
 * iframe (the host pushes it through the bridge context), so every Nuxt UI
 * component keeps its native variants and only changes hue.
 */
export const PageThemeSchema = z.object({
  accent: z.enum(PAGE_ACCENT_TOKENS).optional(),
});
export type PageTheme = z.infer<typeof PageThemeSchema>;

// ==================== //
// CODE (PRESENTATION)  //
// ==================== //

/** Artifacts of one successful server-side compile, embedded in the definition
 * so `published_definition` freezes code+css alongside the grammar for free. */
export const PageCompiledSchema = z.object({
  /** The ES module the iframe runs (imports only `vue`, `@nuxt/ui`, `chart.js`, `#fretik/sdk`). */
  js: z.string().max(PAGE_LIMITS.maxCompiledJsChars),
  /** Tailwind utilities generated from THIS page's source, against the app theme tokens. */
  css: z.string().max(PAGE_LIMITS.maxCompiledCssChars),
  /** Which /page-runtime/<version>/ assets this module was compiled against. */
  runtimeVersion: z.string().max(20),
  /** sha256(source + runtimeVersion + themeTokensHash) — the recompile trigger. */
  sourceHash: z.string().length(64),
  compiledAt: z.string().max(40),
});
export type PageCompiled = z.infer<typeof PageCompiledSchema>;

export const PageCodeSchema = z.object({
  /** One complete Vue SFC: `<template>` (+ optional `<script setup lang="ts">`, `<style scoped>`). */
  source: z.string().max(PAGE_LIMITS.maxSourceChars),
  /** Present after a successful compile; absent means "never compiled cleanly".
   * Stripped from every tool response — the agent reads `source` only. */
  compiled: PageCompiledSchema.optional(),
});
export type PageCode = z.infer<typeof PageCodeSchema>;

// ==================== //
// THE DEFINITION       //
// ==================== //

/**
 * The whole stored page. `version` is a MIGRATION HANDLE, not decoration: the
 * definition lives in a jsonb column, and a format change has to be
 * recognisable without guessing at the shape. (v1 was a nested node tree, v2 a
 * flat spec + JSONata — both dev-era formats, wiped rather than migrated.)
 */
export const PageDefinitionSchema = z.object({
  version: z.literal(3),
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
  code: PageCodeSchema,
});
export type PageDefinition = z.infer<typeof PageDefinitionSchema>;

/** Author-facing: `code` optional so a page can be opened from its datasets
 * alone (the data-first draft path), then written in a second call. */
export const PageDraftDefinitionSchema = PageDefinitionSchema.partial({
  code: true,
});
export type PageDraftDefinition = z.infer<typeof PageDraftDefinitionSchema>;

export const EMPTY_PAGE_DEFINITION: PageDefinition = {
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "" },
};

/** One targeted edit to `code.source` — the artifact-style update channel.
 * Exact-match semantics: `oldString` must occur exactly once unless
 * `replaceAll`. */
export const PageCodeEditSchema = z.object({
  oldString: z.string().min(1).max(PAGE_LIMITS.maxEditChars),
  newString: z.string().max(PAGE_LIMITS.maxEditChars),
  replaceAll: z.boolean().optional(),
});
export type PageCodeEdit = z.infer<typeof PageCodeEditSchema>;
export const PageCodeEditsSchema = z
  .array(PageCodeEditSchema)
  .min(1)
  .max(PAGE_LIMITS.maxEdits);

// ==================== //
// RUNTIME ERRORS       //
// ==================== //

/**
 * Runtime errors reported by the sandboxed page (via the bridge, then
 * `POST /pages/{id}/errors`) — the agent's self-heal feed. A ring buffer of
 * the most recent entries lives on the row; `get`/`update` surface the tail so
 * the agent sees what the browser saw.
 */
export const PageRuntimeErrorSchema = z.object({
  message: z.string().max(2_000),
  stack: z.string().max(6_000).optional(),
  /** Where it surfaced: `window`, `promise`, `vue:<info>`, `mount`, `page`. */
  source: z.string().max(60).optional(),
  at: z.string().max(40),
});
export type PageRuntimeError = z.infer<typeof PageRuntimeErrorSchema>;
export const PAGE_RUNTIME_ERRORS_KEPT = 20;

export const ReportPageErrorRequestSchema = z.object({
  message: z.string().min(1).max(2_000),
  stack: z.string().max(6_000).optional(),
  source: z.string().max(60).optional(),
});
export type ReportPageErrorRequest = z.infer<
  typeof ReportPageErrorRequestSchema
>;

// ==================== //
// GATES                //
// ==================== //

/**
 * The one page defect a warning cannot carry: an empty source renders
 * literally nothing, so accepting the write is worse than refusing it — the
 * caller is told the page was saved and the user opens a blank screen.
 * Everything else about code is the COMPILER's job (a failing compile refuses
 * the write with precise errors).
 */
export const pageBlankError = (code: PageCode): string | null => {
  if (code.source.trim().length === 0) {
    return 'code.source is empty, so the page renders nothing. Write the complete Vue SFC (a <template>, and usually a <script setup lang="ts">).';
  }
  return null;
};

/**
 * COMPLETENESS gate, run at publish (a draft page saves incomplete). Returns
 * an error message, or null when the page is ready to serve publicly.
 */
export const pagePublishError = (definition: PageDefinition): string | null => {
  if (pageBlankError(definition.code)) {
    return "The page has no code to publish.";
  }
  if (!definition.code.compiled) {
    return "The page has never compiled successfully — save it (create/update) until compile errors are gone, then publish.";
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
 * The data half of the page grammar, generated from the schema constants right
 * above it, so a new dataset kind or aggregate function reaches the agent by
 * existing. `managePage`'s `get_guide` action serves it together with the
 * runtime/environment contract — on demand, never in the cached system prompt.
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
    '                 A filter value may be { "var": "<variableKey>" } → the server',
    "                 substitutes that variable's current value on every query, which is",
    "                 how a page control re-filters server-side.",
    "                 An objects dataset also ships its FIELD TYPES with the rows.",
    "mode=records reads a WINDOW of the type, not all of it: `limit` is the page size",
    "(25–100), server-side paging/sorting via the per-dataset `queries` parameter, and",
    "`totalCount` is the real total however many millions sit behind it. A column total",
    "over one page would lie — add an aggregate dataset for figures that must hold.",
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
    '                 args are literals or { "var": "<variableKey>" } references.',
    "                 resultPath is a dot path to the rows inside the answer",
    '                 ("value.items") — run dry_run to see the real shape first.',
    "",
    "## variables (state)",
    `variables: [{ key, type(${PAGE_VARIABLE_TYPES.join("|")}), label?, initial? }]`,
    "Variables are the request contract: the page code sends their VALUES with",
    '`fretik.data.query({ variables: { month: "2026-07" } })`, filters reference them',
    'with { "var": "month" }, and the server drops anything not declared here. Local',
    "UI state that never reaches a query needs no variable — plain refs in the code.",
    "",
    "## operations (writes)",
    "operations: [{ id, providerKey, action, args?, confirm? }]",
    "A write into a connected app, run from the page code as",
    '`await fretik.ops.run("<id>", { variables })`. Connections resolve per viewer,',
    'exactly as a dataset\'s do. args are literals or { "var": "<key>" } references,',
    "so a form field is a variable — no separate form model. confirm: { title,",
    "description? } is rendered by the PARENT app (the page cannot fake consent) and",
    "is REQUIRED for any action the app marks destructive (the server refuses it",
    "otherwise). The verdict comes back to the caller: ok | needs_connection |",
    "blocked | cancelled | error — render it.",
    "A page with operations cannot be published: a public link must not write.",
    "",
    "## theme (optional)",
    `theme: { accent(${PAGE_ACCENT_TOKENS.slice(0, 6).join("|")}|…) } — re-points the page's primary hue.`,
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
  /** Tail of the sandboxed page's error reports — the authoring agent's
   * self-heal feed. Reset on every code write. */
  runtimeErrors: z.array(PageRuntimeErrorSchema),
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

/** List rows omit the definition — a page list must not ship every document. */
export const PageSummarySchema = PageResponseSchema.omit({
  definition: true,
}).extend({
  /** Size of the page's authored surface (the SFC source). */
  sourceBytes: z.number(),
  datasetCount: z.number(),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

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

/**
 * Data request. The viewer's browser may send NOTHING BUT variable values:
 * every filter key, operator and object type comes from the stored
 * definition. That asymmetry is what makes the same executor safe to expose on
 * the anonymous public route.
 */
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
 * What the page code needs to draw ONE field the way the whole workspace draws
 * it — a select's option colours, money's currency, a rating's max.
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
  /** A `FieldDefinitionType`, kept as a plain string so the page code stays
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
  /** Whether a table may order on this field — false for the computed ones. */
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
     * datasets know it.
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
    /** Present for `objects` datasets — typed rendering without guesswork. */
    fields: z.array(PageFieldDescriptorSchema).optional(),
  }),
  /** The viewer's team has no grant on that object type — this block only. */
  z.object({ status: z.literal("forbidden") }),
  /**
   * An external dataset found no usable connection FOR THIS VIEWER — the page
   * itself is fine, so the parent shell renders a "connect your account"
   * prompt instead of an error.
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
 * argument template all come from the stored definition.
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
