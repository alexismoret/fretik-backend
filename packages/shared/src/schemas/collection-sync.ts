import { z } from "@hono/zod-openapi";
import { FIELD_TYPES } from "../db/schema/field-types";

/**
 * Collection sync — the db-free contract.
 *
 * Same split as `schemas/pages.ts` and `schemas/workflows.ts`: the jsonb
 * columns of `db/schema/collection-sync.ts` are typed by the inferred types
 * below, so the shape is declared once and drizzle-kit sees no schema-parse
 * cycle (the reverse edge is type-only and erased at runtime).
 */

export const SYNC_LIMITS = {
  /**
   * Floor on a source's interval. Fifteen minutes rather than Airtable's five:
   * every run costs somebody else's rate limit, and the two cadences are
   * indistinguishable to a person looking at a table. A third party that can
   * tell us the instant something changed deserves a webhook, not a tighter
   * poll — that is the phase-3 seam (`ExternalAppTrigger`), not this number.
   */
  minIntervalMinutes: 15,
  maxIntervalMinutes: 60 * 24 * 7,
  /** Rows one `table` run may pull. Aligned with the auto-index threshold. */
  defaultRowCap: 20_000,
  maxRowCap: 100_000,
  /** Mapped columns per source. A wider upstream row is a modelling problem. */
  maxMappedFields: 60,
  /** Upstream pages one `table` run walks before it stops and says `truncated`. */
  maxPagesPerRun: 200,
  /**
   * Upstream calls one run may make, all pages and all rows together. The
   * ceiling that keeps a misconfigured `lookup` source from spending a team's
   * whole quota in one pass.
   */
  maxUpstreamCallsPerRun: 400,
  /** Records one `lookup` run refreshes. Bounded so a run stays a run. */
  lookupBatchSize: 200,
  /** Wall clock for one run. Past it the run ends `partial` and resumes next time. */
  runBudgetMs: 10 * 60_000,
  /** Rows the preview pulls so a person can see what they are mapping. */
  previewRows: 20,
  /** Runs kept per source. Same retention strategy as `page_versions`. */
  runHistoryLimit: 20,
} as const;

/** Interval choices the UI offers. Free-form minutes are still accepted. */
export const SYNC_INTERVAL_PRESETS = [15, 60, 360, 1440] as const;

// ── Arguments ─────────────────────────────────────────────────────────
//
// An argument is a literal, or one of two bindings the runner resolves. They
// are deliberately the only two: anything richer would be an expression
// language the frontend and the backend could disagree about, and every real
// case is "take this from the record" or "take this from the last run".

/** Take the value from the record being refreshed (`lookup` sources only). */
export const syncFieldBindingSchema = z.object({ $field: z.string().min(1) });
/**
 * Take the source's `lastSuccessAt`, ISO-formatted — an incremental read
 * (`updated_after`, `created_date_from`). On the first run the key is DROPPED
 * rather than sent empty, so a full pass seeds the collection.
 */
export const syncSinceBindingSchema = z.object({ $since: z.literal(true) });

export type SyncArgValue =
  | string
  | number
  | boolean
  | null
  | { $field: string }
  | { $since: true }
  | SyncArgValue[]
  | { [key: string]: SyncArgValue };

export const syncArgValueSchema: z.ZodType<SyncArgValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    syncFieldBindingSchema,
    syncSinceBindingSchema,
    z.array(syncArgValueSchema),
    z.record(z.string(), syncArgValueSchema),
  ]),
);

export const syncArgsSchema = z.record(z.string(), syncArgValueSchema);
export type SyncArgs = z.infer<typeof syncArgsSchema>;

export const isSyncFieldBinding = (
  value: unknown,
): value is { $field: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "$field" in value &&
  typeof Reflect.get(value, "$field") === "string";

export const isSyncSinceBinding = (value: unknown): value is { $since: true } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Reflect.get(value, "$since") === true;

/**
 * Every field key a set of arguments reads. What the journal sweep matches a
 * `record.updated` diff against to decide whether a `lookup` row is stale.
 */
export const syncArgFieldKeys = (args: SyncArgs): string[] => {
  const keys = new Set<string>();
  const walk = (value: SyncArgValue): void => {
    if (isSyncFieldBinding(value)) {
      keys.add(value.$field);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  for (const value of Object.values(args)) walk(value);
  return [...keys];
};

// ── Field mapping ─────────────────────────────────────────────────────

/**
 * One upstream value → one column.
 *
 * `fieldType` is NOT stored here: the field definition owns the type, and a
 * second copy is a second thing to keep in step. What IS stored is the path,
 * because the upstream answer has no other name for the value.
 */
export const syncFieldMappingSchema = z.object({
  /** Dot path into one upstream row, e.g. `departure.city` or `id`. */
  path: z.string().min(1).max(200),
  /** Field key on the collection. Created by the source for a `table` kind. */
  fieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60),
});
export type SyncFieldMapping = z.infer<typeof syncFieldMappingSchema>;

// ── Schedule ──────────────────────────────────────────────────────────

export const syncScheduleSchema = z
  .object({
    mode: z.enum(["manual", "interval"]),
    everyMinutes: z
      .number()
      .int()
      .min(SYNC_LIMITS.minIntervalMinutes)
      .max(SYNC_LIMITS.maxIntervalMinutes)
      .optional(),
    /**
     * Opening the collection refreshes it when the data is older than this.
     * Asynchronous by construction — the table renders from Postgres and the
     * refresh lands behind it. `undefined` / 0 means never.
     */
    refreshOnOpenAfterMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine(
    (schedule) =>
      schedule.mode !== "interval" || schedule.everyMinutes !== undefined,
    { message: "an interval schedule needs everyMinutes" },
  );
export type SyncSchedule = z.infer<typeof syncScheduleSchema>;

// ── Wire: create / update ─────────────────────────────────────────────

export const syncKindSchema = z.enum(["table", "lookup"]);
export const syncOrphanPolicySchema = z.enum(["keep", "reject", "delete"]);

/**
 * A column the caller wants the source to CREATE (`table` sources). The type is
 * proposed by `POST /preview` from the action's declared `ParamSpec` and may be
 * overridden by the user — which is why it travels on create and is then
 * forgotten: from that point the field definition is the truth.
 */
export const syncFieldDraftSchema = z.object({
  path: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  /** Omit to let the server derive it from the label. */
  fieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  type: z.enum(FIELD_TYPES),
  /** Passed to the field definition as-is (select options, money currency, …). */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Exactly one draft may be the collection's title field. */
  isTitle: z.boolean().optional(),
});
export type SyncFieldDraft = z.infer<typeof syncFieldDraftSchema>;

const sourceCoreSchema = z.object({
  connectionId: z.uuid().optional(),
  providerKey: z.string().min(1).max(64),
  operation: z.string().min(1).max(120),
  args: syncArgsSchema.default({}),
  resultPath: z.string().max(200).optional(),
  externalIdPath: z.string().max(200).optional(),
  schedule: syncScheduleSchema.default({ mode: "manual" }),
  orphanPolicy: syncOrphanPolicySchema.default("keep"),
  rowCap: z.number().int().min(1).max(SYNC_LIMITS.maxRowCap).optional(),
});

export const createSyncSourceSchema = sourceCoreSchema
  .extend({
    collectionId: z.uuid(),
    kind: syncKindSchema,
    /** `table`: the columns to create. `lookup`: the columns to fill. */
    fields: z
      .array(syncFieldDraftSchema)
      .min(1)
      .max(SYNC_LIMITS.maxMappedFields),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "table" && !input.externalIdPath) {
      ctx.addIssue({
        code: "custom",
        message:
          "a table source needs externalIdPath — without a stable upstream id every run would duplicate the collection instead of updating it",
        path: ["externalIdPath"],
      });
    }
    if (input.kind === "lookup" && syncArgFieldKeys(input.args).length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          'a lookup source needs at least one {"$field": "<key>"} argument — that binding is what ties an upstream answer to a record',
        path: ["args"],
      });
    }
    const paths = new Set<string>();
    for (const field of input.fields) {
      if (paths.has(field.path)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate mapped path "${field.path}"`,
          path: ["fields"],
        });
      }
      paths.add(field.path);
    }
  });
export type CreateSyncSourceInput = z.infer<typeof createSyncSourceSchema>;

/**
 * What an edit may change. Deliberately NOT the kind, the collection or the
 * external-id path: those decide what a record IS, and changing one would
 * silently re-key every row already stored. Rebuilding is a delete and a
 * create, which is honest about what happens to the data.
 */
export const updateSyncSourceSchema = z
  .object({
    connectionId: z.uuid().nullable().optional(),
    args: syncArgsSchema.optional(),
    resultPath: z.string().max(200).nullable().optional(),
    schedule: syncScheduleSchema.optional(),
    orphanPolicy: syncOrphanPolicySchema.optional(),
    rowCap: z.number().int().min(1).max(SYNC_LIMITS.maxRowCap).optional(),
    enabled: z.boolean().optional(),
    /** Add or drop mapped columns. Dropped ones become ordinary local fields. */
    fields: z
      .array(syncFieldDraftSchema)
      .max(SYNC_LIMITS.maxMappedFields)
      .optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "nothing to update",
  });
export type UpdateSyncSourceInput = z.infer<typeof updateSyncSourceSchema>;

// ── Wire: preview ─────────────────────────────────────────────────────

export const previewSyncSourceSchema = z.object({
  connectionId: z.uuid().optional(),
  providerKey: z.string().min(1).max(64),
  operation: z.string().min(1).max(120),
  args: syncArgsSchema.default({}),
  resultPath: z.string().max(200).optional(),
  /**
   * Resolve `{"$field"}` bindings against this record so a `lookup` preview
   * shows a real answer instead of an empty one.
   */
  sampleRecordId: z.uuid().optional(),
});

/** One candidate column the preview proposes, ready to be accepted as-is. */
export const previewFieldSchema = z.object({
  path: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  config: z.record(z.string(), z.unknown()).optional(),
  /** How the type was decided — the UI says so rather than pretending. */
  origin: z.enum(["declared", "inferred"]),
  /** True when every sampled row carried a distinct non-empty value. */
  candidateId: z.boolean(),
  sample: z.unknown().optional(),
});
export type PreviewField = z.infer<typeof previewFieldSchema>;

export const previewSyncSourceResponseSchema = z.object({
  /** Raw rows, capped at `SYNC_LIMITS.previewRows`. */
  rows: z.array(z.record(z.string(), z.unknown())),
  fields: z.array(previewFieldSchema),
  /** Paths that look like a stable id, best first. */
  suggestedIdPaths: z.array(z.string()),
  /** Present when the answer was not an array of objects. */
  warning: z.string().optional(),
  /** `{page}` / `{list}` / `{fields}` — what the manifest declares it returns. */
  returnsShape: z.string().optional(),
  /** What the action declares about walking it, so the UI can say "all rows". */
  pagination: z
    .object({
      kind: z.enum(["cursor", "offset", "page-number", "auto", "none"]),
      maxLimit: z.number().optional(),
    })
    .optional(),
});
export type PreviewSyncSourceResponse = z.infer<
  typeof previewSyncSourceResponseSchema
>;

// ── Wire: responses ───────────────────────────────────────────────────

export const syncRunResponseSchema = z.object({
  id: z.string(),
  syncSourceId: z.string(),
  status: z.enum(["running", "success", "partial", "failed", "cancelled"]),
  trigger: z.enum(["schedule", "manual", "event", "open", "initial"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  createdCount: z.number(),
  updatedCount: z.number(),
  unchangedCount: z.number(),
  orphanCount: z.number(),
  failedCount: z.number(),
  upstreamCalls: z.number(),
  truncated: z.boolean(),
  error: z.string().nullable(),
  triggeredByUserId: z.string().nullable(),
});
export type SyncRunResponse = z.infer<typeof syncRunResponseSchema>;

export const syncSourceResponseSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  kind: syncKindSchema,
  connectionId: z.string().nullable(),
  providerKey: z.string(),
  /** Denormalised for display so the UI never fetches the catalogue to draw a row. */
  connection: z
    .object({
      id: z.string(),
      displayName: z.string(),
      status: z.enum(["active", "disabled", "error"]),
      /** MCP connections carry their own logo; manifest apps use the catalogue. */
      iconUrl: z.string().nullable(),
    })
    .nullable(),
  operation: z.string(),
  /** One line from the manifest / snapshot, so the UI names the action in prose. */
  operationSummary: z.string().nullable(),
  args: syncArgsSchema,
  resultPath: z.string().nullable(),
  externalIdPath: z.string().nullable(),
  fieldMapping: z.array(syncFieldMappingSchema),
  schedule: syncScheduleSchema,
  orphanPolicy: syncOrphanPolicySchema,
  rowCap: z.number(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  nextRunAt: z.string().nullable(),
  /** True while a run is in flight — the UI spins instead of offering Refresh. */
  running: z.boolean(),
  /**
   * Derived health, so every surface says the same word:
   *  - `never_run`  : created, nothing pulled yet
   *  - `ok`         : last run succeeded
   *  - `stale`      : succeeded, but longer ago than its own interval allows
   *  - `error`      : last run failed
   *  - `disconnected`: its connection is gone, disabled, or in error
   *  - `paused`     : the user turned it off
   */
  health: z.enum([
    "never_run",
    "ok",
    "stale",
    "error",
    "disconnected",
    "paused",
  ]),
  lastRun: syncRunResponseSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SyncSourceResponse = z.infer<typeof syncSourceResponseSchema>;

export type SyncSourceHealth = SyncSourceResponse["health"];
