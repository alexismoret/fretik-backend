import { z } from "zod";
// The bulk ceiling is NOT re-derived here: `lib/db-bulk` is the single source
// of truth for it, and it is the same number the objects bulk services enforce.
// A page that refused what the service it calls accepts would be a divergence
// nobody could explain from either side.
import { MAX_BULK_ITEMS } from "../lib/db-bulk";
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

/**
 * Ceilings, sized for the ambition: a page may stand in for a piece of
 * software, not just report on one. So these are set where a value stops being
 * a PAGE and starts being a bug — not where a cautious first version happened
 * to land.
 *
 * Measured 2026-08-15 (`compilePageCode` on synthetic sources): compile time is
 * FLAT at ~220 ms from 30k to 117k chars, so the Tailwind subprocess timeout
 * has ~40× headroom and source size costs nothing. The binding pair is instead
 * `maxSourceChars` → `maxCompiledJsChars`: compiled JS measures ~2.5× the
 * source, so the two must move together or the JS ceiling refuses a source the
 * source ceiling allowed. Emitted CSS stayed at 3k throughout — Tailwind emits
 * only used utilities and they dedupe, so that ceiling is nowhere near binding.
 */
export const PAGE_LIMITS = {
  /** A page over several connected apps plus the team's own records. */
  maxDatasets: 40,
  maxVariables: 40,
  maxFilters: 20,
  /** Per aggregate dataset — a KPI band of six measures is ordinary. */
  maxMetrics: 8,
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
  /**
   * What ONE dataset may put on the wire, measured on its serialized rows.
   *
   * Every other bound here counts ROWS, and rows are not a size: 2 000 records
   * whose `markdown` field holds a page each is a response nobody's browser
   * wants and nothing was refusing. The retired `transform` sandbox capped its
   * own output at 1 MB, so removing it removed the only byte ceiling in the
   * path — this replaces it, and covers the two sources that never had one.
   *
   * Enforced by TRUNCATING, never by failing: the page renders what fits and
   * `truncated` says so, which is a state every dataset already has to handle.
   */
  maxDatasetResponseBytes: 2_000_000,
  /**
   * How long an external dataset's upstream answer may be reused, seconds.
   * The floor exists because a page renders far more often than a third party
   * wants to be called; the ceiling because past 15 minutes the data is not
   * "live" and belongs in an object type.
   */
  minExternalTtlSeconds: 15,
  maxExternalTtlSeconds: 900,
  defaultExternalTtlSeconds: 60,
  /**
   * Declared write/read operations one page may run. The ceiling that binds
   * ambition first: a mailbox alone wants send, reply, reply-all, forward,
   * delete, move, flag, mark read/unread, archive and their bulk forms.
   */
  maxOperations: 40,

  /** The page's Vue SFC source, characters. */
  maxSourceChars: 240_000,
  /** Compiled module / stylesheet ceilings — a compile output past these is a
   * bug, not a page. JS tracks `maxSourceChars` at the measured ~2.5× ratio. */
  maxCompiledJsChars: 800_000,
  maxCompiledCssChars: 100_000,
  /**
   * Targeted source edits per update call.
   *
   * 30 was set against the wrong picture of the work: few, fat blocks. The
   * real workload is many, thin ones — measured over 33 updates from real
   * builds (2026-08-23), the median update touches 31 separate sites, the p90
   * touches 68, and 18 of the 33 needed more than 30. Under a cap the changes
   * do not fit, the model merges distant sites into one block that swallows
   * the untouched lines between them, and then pays for those lines TWICE, as
   * `oldString` and again as `newString`. The cap was buying the padding it
   * was meant to prevent. 80 clears the p90 with headroom; `maxEditChars`
   * still bounds any single block.
   */
  maxEdits: 80,
  /**
   * One edited block. Sized for the way a LARGE page is written: the model
   * emits a compilable skeleton with named section stubs, then replaces each
   * stub with its finished region — so a `newString` here is a whole section
   * (a board with its columns and card, a table with its cells and toolbar),
   * not a tweak. 8 000 cut those in half and forced a second chained edit for
   * no reason; the real ceiling on one turn is the model's output budget, and
   * this sits well under it.
   */
  maxEditChars: 12_000,

  /** The brief. Bounded because it is a decision record, not a document —
   * but the feature list is what a software replacement is measured in. */
  maxBriefFieldChars: 800,
  maxBriefFeatures: 40,
} as const;

/**
 * Identifier for datasets, variables, metrics and filter keys.
 *
 * Narrow on purpose: these names are read back as PROPERTIES in JavaScript —
 * `datasets.sales.rows` in the page code — where
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
 *
 * `transform` was a fourth kind, REMOVED 2026-08-21. It ran JavaScript in a
 * server-side QuickJS-WASM sandbox over the results of other datasets, and the
 * two things it was for both had better homes on either side of it: grouping
 * and summing belong in an `aggregate` dataset, in SQL, over every row — which
 * the contract already forbade it from doing — and joining, ratios and derived
 * columns belong in the page's own `computed()`, which runs in the browser the
 * page is already rendering in. What remained was a second execution
 * environment to secure, a 9.2 MB dependency, and a dependency-wave scheduler
 * in `run-page-data.ts` that existed for this one source. Stored definitions
 * were migrated (`…_retire_page_transform_datasets`).
 */
export const PAGE_DATASET_KINDS = ["inline", "objects", "external"] as const;
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
 * a page may be built entirely from `inline` data, or read a connected app
 * live. Derived columns, ratios and joins across datasets are the PAGE's own
 * work, in a `computed()`; grouping and summing are an `aggregate` dataset's,
 * in SQL, over every row rather than over the window that happened to load.
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
 * What a page may DO. Datasets read; operations act.
 *
 * Declared at the top level, for the same reason a dataset is: the STORED
 * definition is the security boundary. The page code calls
 * `fretik.ops.run("<id>", { variables })` through the bridge; the browser
 * sends an operation ID and values for the page's declared VARIABLES — never
 * an action name, never an argument template, never a connection, never an
 * object type. The server re-resolves the stored `args` against those values,
 * so the worst a forged request can do is pass a different string where a
 * string was already going to go.
 *
 * FOUR KINDS. `app` was the only one until 2026-08-17, and that was a hole
 * rather than a design: a page could call out to a connected third party but
 * could not touch the team's OWN records. Every "the page draws a control that
 * does nothing" defect since Phase 8 traces back to it — the shipped kanban
 * pattern told the agent to run `set_stage` over a `records` dataset, which no
 * operation kind could execute. `record`, `bulk` and `link` close it.
 *
 * `confirm` is not decoration: a destructive action is REFUSED server-side
 * unless the page declared one, and the PARENT shell (not the sandboxed page)
 * renders the confirmation — a "delete everything" button cannot be one click,
 * and the page code cannot fake the consent.
 */
export const PAGE_OPERATION_KINDS = ["app", "record", "bulk", "link"] as const;
export const pageOperationKindSchema = z.enum(PAGE_OPERATION_KINDS);
export type PageOperationKind = z.infer<typeof pageOperationKindSchema>;

export const PAGE_RECORD_MODES = ["create", "update", "delete"] as const;
export const pageRecordModeSchema = z.enum(PAGE_RECORD_MODES);
export type PageRecordMode = z.infer<typeof pageRecordModeSchema>;

const pageConfirmSchema = z.object({
  title: z.string().max(120),
  description: z.string().max(400).optional(),
});

/** Argument template — literals, or `{ "var": "<key>" }` references to state.
 * Its KEYS are also the writable field allowlist for a record write: nothing
 * outside them reaches the row. */
const pageArgsSchema = z.record(z.string(), pageValueSchema);

/** One record id: a literal, or the `{ var }` the viewer fills in. */
const pageRecordIdSchema = z.union([z.string().max(64), PageVarRefSchema]);
/** Many: a literal list, or a `string_list` variable holding the selection. */
const pageRecordIdsSchema = z.union([
  z.array(z.string().max(64)).max(MAX_BULK_ITEMS),
  PageVarRefSchema,
]);

const pageAppOperationSchema = z.object({
  kind: z.literal("app"),
  id: pageKeySchema,
  /** Pin ONE connection. Omit to resolve per viewer, like a dataset. */
  connectionId: z.uuid().optional(),
  providerKey: z.string().max(80).optional(),
  /** The action to call on it — a name from the app's own catalogue. */
  action: z.string().max(120),
  args: pageArgsSchema.optional(),
  confirm: pageConfirmSchema.optional(),
});

const pageRecordOperationSchema = z.object({
  kind: z.literal("record"),
  id: pageKeySchema,
  /** The type this writes to — from the definition, never from the request. */
  objectTypeId: z.uuid(),
  mode: pageRecordModeSchema,
  /** Which row. Omitted for `create`. */
  recordId: pageRecordIdSchema.optional(),
  args: pageArgsSchema.optional(),
  confirm: pageConfirmSchema.optional(),
});

/**
 * The same write over a SELECTION.
 *
 * `create` is deliberately absent: a bulk operation acts on rows the viewer
 * picked, and there is no selection to pick before a row exists. Creating many
 * at once is an import, and the objects UI already owns imports — the skill's
 * "when a page is the wrong answer" says so already.
 *
 * It exists because the bridge allows 30 calls per 10 s SHARED with
 * `data.query`: approving twelve selected rows one call at a time brushes that
 * ceiling and refetches twelve times.
 */
const pageBulkOperationSchema = z.object({
  kind: z.literal("bulk"),
  id: pageKeySchema,
  objectTypeId: z.uuid(),
  mode: z.enum(["update", "delete"]),
  recordIds: pageRecordIdsSchema,
  args: pageArgsSchema.optional(),
  confirm: pageConfirmSchema.optional(),
});

/**
 * Attach or detach one end of a `relation` field — assign an owner, tag a
 * record, attach a document.
 *
 * A relation is an edge in the links graph, not a column, so it is unreachable
 * through `record`'s `args`. Without this kind a page can write every field
 * type EXCEPT the one that connects records to each other.
 */
const pageLinkOperationSchema = z.object({
  kind: z.literal("link"),
  id: pageKeySchema,
  objectTypeId: z.uuid(),
  /** The `relation` field on that type whose edges this operation moves. */
  fieldKey: pageKeySchema,
  mode: z.enum(["link", "unlink"]),
  fromRecordId: pageRecordIdSchema,
  toRecordId: pageRecordIdSchema,
  confirm: pageConfirmSchema.optional(),
});

/**
 * `kind` defaults to `app` through a PREPROCESS rather than a `.default()`:
 * a discriminated union picks its arm before any default runs, so a stored
 * operation written before `kind` existed would fail to match any arm and take
 * the whole page's definition down with it. What a schema drops, nothing
 * downstream can put back.
 */
export const PageOperationSchema = z
  .preprocess(
    (value) =>
      isPlainObject(value) && value["kind"] === undefined
        ? { ...value, kind: "app" }
        : value,
    z.discriminatedUnion("kind", [
      pageAppOperationSchema,
      pageRecordOperationSchema,
      pageBulkOperationSchema,
      pageLinkOperationSchema,
    ]),
  )
  .superRefine((op, ctx) => {
    // Closes a silent authoring trap: `{ id, action, args }` used to validate,
    // save and warn about nothing, then fail at run time with "a connection
    // needs providerKey or a pinned connectionId".
    if (op.kind === "app" && !op.providerKey && !op.connectionId) {
      ctx.addIssue({
        code: "custom",
        message: `operation "${op.id}": an app operation needs providerKey (or a pinned connectionId) — without one there is nothing to call.`,
        path: ["providerKey"],
      });
    }
    if (op.kind === "record" && op.mode !== "create" && !op.recordId) {
      ctx.addIssue({
        code: "custom",
        message: `operation "${op.id}": ${op.mode} needs recordId naming which row to act on.`,
        path: ["recordId"],
      });
    }
    // Deleting is destructive by construction — the app path already refuses a
    // destructive action with no confirm, and a row is no cheaper to lose.
    if (
      (op.kind === "record" || op.kind === "bulk") &&
      op.mode === "delete" &&
      op.confirm === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: `operation "${op.id}": deleting records needs a confirm step — the app renders it, the page cannot fake the consent.`,
        path: ["confirm"],
      });
    }
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
 * The only values a Nuxt UI `color` prop accepts — the seven SEMANTIC aliases
 * the runtime's theme declares, which is a different alphabet from the Tailwind
 * hues above.
 *
 * The distinction has no runtime enforcement and fails silently: the prop has
 * no validator, so `<UBadge color="violet">` matches no variant, and because
 * the prop IS set the component's own default never applies either. The badge
 * renders with its base and size classes alone — transparent, inherited grey,
 * no console warning. A data hue reaches a component through `:style` and
 * `var(--color-violet-500)`, never through `color`.
 */
export const PAGE_COMPONENT_COLORS = [
  "primary",
  "secondary",
  "success",
  "info",
  "warning",
  "error",
  "neutral",
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
// BRIEF (INTENT)       //
// ==================== //

const briefField = z.string().max(PAGE_LIMITS.maxBriefFieldChars);

/**
 * What this page is FOR and what it should look like — decided before a line
 * of code and stored beside it.
 *
 * It exists because the request that starts a page is usually a sentence from
 * someone non-technical, and a generator handed a vague sentence under-scopes:
 * it builds the literal ask and stops. Writing the intent down first turns
 * taste words into countable commitments ("modern" → these nine features, this
 * layout, this one memorable element), and keeps them countable later — a
 * second turn can check the page against its own brief instead of re-reading
 * a chat history that compaction may already have dropped.
 *
 * Stored in the definition rather than in the conversation for exactly that
 * reason: it has to outlive the turn that produced it.
 */
export const PageBriefSchema = z.object({
  product: z.object({
    /** The one job. "Work a mailbox without leaving Fretik." */
    job: briefField,
    /** Who opens it, and what they are in the middle of doing. */
    audience: briefField,
    /**
     * The features this page commits to, each one a thing a person can DO.
     * This is the anti-under-scoping device: a vague request becomes a list
     * that can be counted, argued with, and checked off.
     */
    features: z.array(briefField).max(PAGE_LIMITS.maxBriefFeatures).default([]),
  }),
  design: z.object({
    /** The layout in prose — regions, what sits where, what dominates. */
    layout: briefField,
    /** The ONE element this page is remembered by. Boldness is spent here. */
    signature: briefField,
    /** The single orchestrated moment of motion, if any. */
    motion: briefField.optional(),
  }),
});
export type PageBrief = z.infer<typeof PageBriefSchema>;

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
  /** Optional, and additive on purpose: every page stored before the brief
   * existed still parses, so no migration and no version bump. */
  brief: PageBriefSchema.optional(),
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
  after: z.string().min(1).max(PAGE_LIMITS.maxEditChars).optional(),
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
  // Same rule, one step stronger: an operation WRITES — to a third party on the
  // team's credentials, or to the team's own records. A link anyone can open
  // must not carry one, whatever it is guarded by client-side. A published page
  // is a read-only view of live data, and nothing else.
  const [operation] = definition.operations;
  if (operation !== undefined) {
    const target =
      operation.kind === "app"
        ? "writes to a connected app"
        : "writes to the team's records";
    return `Operation "${operation.id}" ${target}, which a published page may not do — anyone with the link could run it. Keep this page internal, or remove its operations.`;
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
    "kind=external  → providerKey + operation (+ args, resultPath?, cacheTtlSeconds?).",
    "                 A live read from a connected app. Name the PROVIDER: each viewer",
    "                 then reads through their own connection, the team's otherwise.",
    "                 `connectionId` pins one account for everyone — only when they all",
    "                 must see that same account.",
    '                 args are literals or { "var": "<variableKey>" } references.',
    "                 resultPath is a dot path to the rows inside the answer",
    '                 ("value.items") — run dry_run to see the real shape first.',
    "                 Its rows ship `fields` too, inferred from the answer: the",
    "                 provider's key humanised, and a type only where every value",
    "                 agrees (`unknown` otherwise — do not format one blind).",
    "",
    "## row shapes (objects datasets)",
    "A row is `{ id, label, …fields }`; `label` is the record's own title.",
    "text/url/email/phone/markdown → string. number/rating → number. boolean → boolean.",
    "select       → the option's VALUE, never its label — the label is in `fields`.",
    "multi_select → string[].                    money → { amount, currencyCode }.",
    'date         → "2026-09-21", ISO datetime when the descriptor says hasTime.',
    "relation     → [{ id, label }] — `[]` when nothing is linked, never null.",
    'rollup       → a string even when it counts ("0"): Number() it before comparing.',
    "unique_id    → the bare number; the descriptor's `prefix` makes the display form.",
    "member, created_by, last_edited_by → raw user uuids with no name attached.",
    "location     → { address, lat, lng }.",
    "formula      → its declared kind, already computed (a number arrives as a",
    "               number). Read-only, and sortable/filterable like any column.",
    "A derived value the page must SORT, FILTER or AGGREGATE on belongs in a",
    "`formula` field on the object type, not in the page: sorting a table by",
    "margin only works if the server knows margin. Reshaping for display — a",
    "label, a merge of two datasets, chart buckets — stays in the page's own JS.",
    "",
    "## variables (state)",
    `variables: [{ key, type(${PAGE_VARIABLE_TYPES.join("|")}), label?, initial? }]`,
    "Variables are the request contract: the page code sends their VALUES with",
    '`fretik.data.query({ variables: { month: "2026-07" } })`, filters reference them',
    'with { "var": "month" }, and the server drops anything not declared here. Local',
    "UI state that never reaches a query needs no variable — plain refs in the code.",
    "",
    "## operations (writes)",
    'Every one runs as `await fretik.ops.run("<id>", { variables })` and answers',
    "ok | needs_connection | blocked | cancelled | error — render the verdict.",
    'args are literals or { "var": "<key>" } references, so a form field is a',
    "variable and there is no separate form model. Four kinds:",
    "kind=record → objectTypeId + mode(create|update|delete) + recordId + args.",
    "                 Writes the team's OWN records. `args` KEYS ARE THE WRITABLE",
    "                 FIELD LIST — nothing outside them can reach the row, and an",
    "                 update carrying none of them changes nothing. Fields whose",
    "                 descriptor says writable:false are refused by name.",
    "kind=bulk   → the same over recordIds: [] — one call for a whole selection,",
    `                 up to ${MAX_BULK_ITEMS.toString()}. update|delete only; creating many is an import.`,
    "kind=link   → fieldKey + mode(link|unlink) + fromRecordId + toRecordId.",
    "                 Moves a `relation` edge — assigning an owner, tagging,",
    "                 attaching. A relation is NOT writable through args. On a",
    "                 cardinality-one relation, linking REPLACES.",
    "kind=app    → providerKey + action (+ args). A write into a connected app;",
    "                 connections resolve per viewer, exactly as a dataset's do.",
    "confirm: { title, description? } is rendered by the PARENT app (the page",
    "cannot fake consent). REQUIRED for any delete, and for any app action the app",
    "itself marks destructive — the server refuses the write otherwise.",
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
 * grouping IS the query, and for inline rows the client already holds
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
        /** Ready for `<UIcon :name>` as-is — normalised server-side, never wrap it. */
        icon: z.string().optional(),
      }),
    )
    .optional(),
  currencyCode: z.string().optional(),
  /**
   * formula: what the expression evaluates to (`number` | `text` | `boolean` |
   * `date`). A computed column's VALUE cannot tell a page which one it is —
   * an empty cell tells it nothing at all — so the kind travels with it.
   */
  resultType: z.string().optional(),
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
  /**
   * Whether a `record` operation may write this field through `args`.
   *
   * False for a relation (an edge — move it with a `link` operation), a rollup,
   * and the read-only system properties. Binding a form control to one of them
   * produces a save that reports success and changes nothing, because the write
   * path strips the key instead of refusing it.
   */
  writable: z.boolean().optional(),
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
