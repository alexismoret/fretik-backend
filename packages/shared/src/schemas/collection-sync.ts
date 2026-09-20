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
  /**
   * Ceiling a source may be raised to. A MILLION, the same number
   * `MAX_BULK_OPERATION_ITEMS` puts on one bulk load — and affordable for the
   * same reason: since the walk streams page by page and diffs each page
   * against Postgres, the rows are never all in memory at once. Under the old
   * collector this was 100 000 because that was roughly what a run could hold.
   */
  maxRowCap: 1_000_000,
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
  /**
   * Continuations one walk may chain before it gives up and says `legs_cap`.
   *
   * Twelve × `runBudgetMs` is two hours of walking, which is a first load of a
   * very large collection and not a loop. The cap exists because a resumable
   * walk whose provider always answers one page in just over the budget would
   * otherwise re-enqueue itself forever, and nobody would be told.
   */
  maxRunLegs: 12,
  /**
   * The orphan floor: a full walk that would orphan MORE than this share of
   * what the source tracks applies no policy at all and asks for a
   * confirmation instead.
   *
   * Twenty per cent, with a twenty-row minimum so a small collection is not
   * held hostage by arithmetic (4 of 15 rows legitimately disappearing is
   * 27%). The floor is what stands between "the upstream filter changed" and
   * "the collection was deleted" — the two look identical in an answer, and
   * only one of them should ever reach `reject` or `delete`.
   */
  orphanFloorRatio: 0.2,
  orphanFloorMinRows: 20,
  /**
   * How long a `lookup` record marked `missing` rests before it is asked
   * again. A week: the answer cannot change until the record does (and an edit
   * marks it `pending` immediately), so this is purely the backstop for an
   * upstream that gained a row we were told did not exist.
   */
  lookupMissingRetryMs: 7 * 24 * 60 * 60_000,
  /** Records one `lookup` run may take when the action batches. */
  lookupMaxRecordsPerRun: 20_000,
  /** Rows written per statement while a page is being absorbed. */
  walkPageWriteChunk: 500,
  /**
   * How often an incremental source walks EVERYTHING anyway.
   *
   * An incremental read (`{"$since": true}`) is handed only the rows that
   * changed, so "not in the answer" carries no information about the rest —
   * see the orphan bracket. Daily, which is what Nango tells its users to do
   * for the same reason: a deletion upstream is invisible until a full pass
   * looks for it.
   */
  fullWalkIntervalMinutes: 1440,
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

/**
 * Does this source read INCREMENTALLY — i.e. does anything in its arguments
 * bind `{"$since": true}`?
 *
 * The question the orphan bracket turns on. An incremental answer contains
 * only what changed, so "not in the answer" means "did not change" and
 * diffing it for orphans would declare the entire untouched collection gone.
 */
export const syncArgsBindSince = (args: SyncArgs): boolean => {
  const walk = (value: SyncArgValue): boolean => {
    if (isSyncSinceBinding(value)) return true;
    if (Array.isArray(value)) return value.some(walk);
    if (typeof value === "object" && value !== null) {
      return Object.values(value).some(walk);
    }
    return false;
  };
  return Object.values(args).some(walk);
};

/**
 * HOW a source reads its app, derived from its arguments alone.
 *
 *  - `row`  : one call per record. The arguments bind `{"$field": "<key>"}`,
 *             so each record's own values ARE the call — there is nothing to
 *             walk, because the app answers about one thing at a time.
 *  - `walk` : one call per page. The action's list is read to the end and each
 *             row is matched locally.
 *
 * Derived rather than stored, and that is the point: a stored strategy is a
 * third thing that can disagree with the arguments and with the action, and
 * the disagreement would only show up as a run that cost 200 calls instead of
 * two. Here there is nothing to contradict — a `{$field}` binding IS the
 * per-record read.
 *
 * A `table` source is always walked and never asks this: its rows come from
 * the list, so a `{$field}` binding on one is refused at the door.
 */
export type SyncReadStrategy = "walk" | "row";

export const syncReadStrategy = (args: SyncArgs): SyncReadStrategy =>
  syncArgFieldKeys(args).length > 0 ? "row" : "walk";

/**
 * Why a `columns` source's shape is not usable, or `undefined` when it is.
 *
 * A `columns` source needs EXACTLY ONE way to tie an answer to a record:
 * either a `{"$field"}` binding (ask the app about this record) or a match
 * column plus the path to compare it against (walk the list and recognise the
 * record). Neither, and the source has no way to know whose answer is whose.
 * Both, and two mechanisms describe the same thing — the runner would pick
 * one and silently ignore what the user configured in the other.
 *
 * One function, two callers: the create schema's `superRefine` and the update
 * service, which has to re-ask the question against the shape an edit would
 * LEAVE BEHIND rather than the one it was given.
 */
export const columnsShapeIssue = (input: {
  args: SyncArgs;
  matchFieldKey?: string | null;
  externalIdPath?: string | null;
}): string | undefined => {
  const bound = syncArgFieldKeys(input.args).length > 0;
  const hasMatch =
    input.matchFieldKey !== undefined && input.matchFieldKey !== null;
  const hasPath =
    input.externalIdPath !== undefined && input.externalIdPath !== null;

  if (bound && (hasMatch || hasPath)) {
    return 'a columns source is read one way or the other: bind {"$field": "<column key>"} to ask the app about each record, OR give matchFieldKey + externalIdPath to walk its list and match rows. Not both.';
  }
  if (bound) return undefined;
  if (hasMatch && hasPath) return undefined;
  if (hasMatch) {
    return "matchFieldKey names the column on your records; externalIdPath must name the value in the app's row it has to equal.";
  }
  if (hasPath) {
    return "externalIdPath names the value in the app's row; matchFieldKey must name the column on your records it has to equal.";
  }
  return 'a columns source needs a way to tie an answer to a record: either matchFieldKey + externalIdPath (one call per page, the cheap one), or an argument bound to {"$field": "<column key>"} (one call per record, for an app with no list).';
};

/**
 * WHERE the `{"$since": true}` bindings sit — the top-level keys carrying one,
 * and whether any sits deeper than the top level.
 *
 * `syncArgsBindSince` asks only "is there one anywhere", and that answer alone
 * decides whether the orphan bracket runs. So a `$since` bound to the WRONG
 * parameter costs twice: the app never receives a lower bound and answers with
 * everything, and the run calls itself incremental and skips the diff — a
 * source that quietly stops noticing deletions, reporting `success` the whole
 * time. Nothing downstream can tell the two apart, which is why the placement
 * is checked once, where the source is declared, against the parameter the
 * action actually declares as incremental.
 */
export const syncArgsSincePlacement = (
  args: SyncArgs,
): { topLevel: string[]; nested: boolean } => {
  const topLevel: string[] = [];
  let nested = false;
  const walk = (value: SyncArgValue): void => {
    if (isSyncSinceBinding(value)) {
      nested = true;
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
  for (const [key, value] of Object.entries(args)) {
    if (isSyncSinceBinding(value)) {
      topLevel.push(key);
      continue;
    }
    walk(value);
  }
  return { topLevel, nested };
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

// ── Walk checkpoint ───────────────────────────────────────────────────
//
// What a suspended walk leaves behind so the next leg picks up where it
// stopped instead of asking the third party for page one again.

/** Where in the upstream list the next call resumes. */
export type WalkPosition =
  | { kind: "cursor"; token: string }
  | { kind: "offset"; offset: number }
  | { kind: "page"; page: number };

/** Why a run stopped short of "every row, diffed". */
export type SyncStopReason =
  | "rate_limited"
  | "deadline"
  | "row_cap"
  | "page_cap"
  | "call_cap"
  | "unpaged"
  | "orphan_floor"
  | "legs_cap"
  /**
   * A walked `columns` source whose match column is empty everywhere. Nothing
   * to match against, so the walk is not worth a single call — the common
   * case being a source declared before the `table` source that fills its key
   * has ever run.
   */
  | "no_match_keys";

/** What one run did. Every counter the run row carries, and the checkpoint's. */
export interface SyncRunCounts {
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  orphanCount: number;
  failedCount: number;
  /** `columns`: records the app had no answer for. Written so they rest. */
  missingCount: number;
  /** `columns`, walked: upstream rows that matched no record here. */
  unmatchedCount: number;
  upstreamCalls: number;
  truncated: boolean;
}

/**
 * A walk frozen mid-flight, stored on `collection_sync_sources.walk_checkpoint`.
 *
 * In the database rather than in the job, because the job is in Redis and the
 * walk it belongs to may span two hours and a deploy. It is also why
 * `configHash` is here: a source whose arguments were edited between two legs
 * must restart, and comparing hashes is the only way to notice that a position
 * now points into a different list.
 */
export interface TableWalkCheckpoint {
  /** Bumped when this shape changes; an older one is discarded, not migrated. */
  version: 1;
  /** The run this belongs to — every leg reuses it, so one walk is one run. */
  runId: string;
  /** `collection_sync_runs.started_at` — the bracket's `synced_at` boundary. */
  walkStartedAt: string;
  configHash: string;
  /** The `{"$since"}` bound frozen for the whole walk; null on a full walk. */
  sinceAt: string | null;
  position: WalkPosition | null;
  rowsSeen: number;
  calls: number;
  pagesDone: number;
  legs: number;
  counts: SyncRunCounts;
  /** Set by a confirmed full resync — this walk applies its policy whatever. */
  ignoreOrphanFloor: boolean;
  /** True when this walk asks for EVERYTHING, so the diff may be trusted. */
  fullWalk: boolean;
}

// ── Wire: create / update ─────────────────────────────────────────────

export const syncKindSchema = z.enum(["table", "columns"]);
export type SyncKind = z.infer<typeof syncKindSchema>;
export const syncOrphanPolicySchema = z.enum(["keep", "reject", "delete"]);

/**
 * The most one run of this source could reach, and what that costs upstream.
 *
 * A WORST case, and the only honest kind of estimate here: nobody knows at
 * preview time how many rows the app holds or how many records the collection
 * will end up with, and an estimate that guessed low would be worse than none.
 * The whole use of the number is to catch a cadence that cannot fit, and that
 * comparison only works against the ceiling.
 *
 * The two kinds cost differently by an order of magnitude and the difference is
 * invisible on screen, which is exactly why this exists. A `table` source pays
 * one call per PAGE — a thousand rows for one call, on a well-declared action.
 * A `lookup` source pays one call per RECORD unless the action declares that it
 * takes several ids at once. Before this function, `estimateSyncCost` gave
 * every unpaginated action one call per run, which is right for a `table` whose
 * answer is whole and wrong by up to `lookupBatchSize` for every `lookup` —
 * understating the one cost a person most needs to see, in the one direction
 * that hurts.
 *
 * Mirrored in the frontend's `types/api/collectionSync.ts`, beside the copy of
 * `SYNC_LIMITS` it reads. The form has to show the number while the cadence is
 * still being chosen, so it cannot wait for a round trip.
 */
export const syncRunCeiling = (input: {
  /**
   * WHICH cost model applies. The kind does not decide this — a `columns`
   * source is walked or read per record depending on its arguments, and the
   * difference between the two is two orders of magnitude.
   */
  read: SyncReadStrategy;
  /** `table` only — the source's own cap on rows per run. */
  rowCap?: number;
  /** Rows the action returns per call, when it declares a page size. */
  pageSize?: number;
  /** Ids the action takes per call, when it declares batching. */
  batchMaxItems?: number;
}): { records: number; calls: number } => {
  if (input.read === "walk") {
    const records = input.rowCap ?? SYNC_LIMITS.defaultRowCap;
    // No declared page size means the answer arrives whole: one call.
    const calls =
      input.pageSize === undefined || input.pageSize <= 0
        ? 1
        : Math.ceil(records / input.pageSize);
    return { records, calls };
  }
  // `candidateLimit` in `run-row-sync.ts`, which is what actually bounds the
  // work list. Without batching the call budget IS the bound, so the two
  // numbers are the same and a person reading "200 rows, 200 requests" has
  // understood the whole cost model of a per-record read in one line.
  const batch = input.batchMaxItems;
  if (batch === undefined || batch <= 1) {
    return {
      records: SYNC_LIMITS.lookupBatchSize,
      calls: SYNC_LIMITS.lookupBatchSize,
    };
  }
  const records = Math.min(
    SYNC_LIMITS.maxUpstreamCallsPerRun * batch,
    SYNC_LIMITS.lookupMaxRecordsPerRun,
  );
  return { records, calls: Math.ceil(records / batch) };
};

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
  /** `columns`, walked — the column an upstream row is recognised by. */
  matchFieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  schedule: syncScheduleSchema.default({ mode: "manual" }),
  orphanPolicy: syncOrphanPolicySchema.default("keep"),
  rowCap: z.number().int().min(1).max(SYNC_LIMITS.maxRowCap).optional(),
});

export const createSyncSourceSchema = sourceCoreSchema
  .extend({
    collectionId: z.uuid(),
    kind: syncKindSchema,
    /** `table`: the columns to create. `columns`: the columns to fill. */
    fields: z
      .array(syncFieldDraftSchema)
      .min(1)
      .max(SYNC_LIMITS.maxMappedFields),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "table") {
      if (!input.externalIdPath) {
        ctx.addIssue({
          code: "custom",
          message:
            "a table source needs externalIdPath — without a stable upstream id every run would duplicate the collection instead of updating it",
          path: ["externalIdPath"],
        });
      }
      // A table source's rows come FROM the list. A per-record binding would
      // ask it to resolve each record's arguments before the records exist.
      if (syncArgFieldKeys(input.args).length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            'a table source creates the records, so it cannot read one of their columns: {"$field"} belongs to a columns source',
          path: ["args"],
        });
      }
      if (input.matchFieldKey !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "a table source recognises a row by its own upstream id (externalIdPath), never by a column of the collection it owns",
          path: ["matchFieldKey"],
        });
      }
    }
    if (input.kind === "columns") {
      const issue = columnsShapeIssue(input);
      if (issue !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: issue,
          path: ["matchFieldKey"],
        });
      }
      // The match column is READ to decide whose answer this is. A source that
      // also WROTE it would move the target between runs: the app's own value
      // would overwrite the key that found it, and the next walk would match
      // a different record — or none.
      if (
        input.matchFieldKey !== undefined &&
        input.fields.some((field) => field.fieldKey === input.matchFieldKey)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `"${input.matchFieldKey}" is how rows are matched, so this source cannot also fill it — map a different column, or match on one the app does not send`,
          path: ["matchFieldKey"],
        });
      }
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
   * Resolve `{"$field"}` bindings against this record so a per-record preview
   * shows a real answer instead of an empty one.
   */
  sampleRecordId: z.uuid().optional(),
  /**
   * Try the match, on these three together: how many of the sampled rows
   * would land on a record of `collectionId` whose `matchFieldKey` column
   * equals their `externalIdPath` value.
   *
   * The whole point of asking before creating. A walked `columns` source with
   * the wrong key is not an error — it is a source that runs, succeeds, and
   * fills nothing, and `matched: 0` is the only moment that is cheap to see.
   */
  collectionId: z.uuid().optional(),
  matchFieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  externalIdPath: z.string().max(200).optional(),
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
  /**
   * What the action declares about taking several ids at once.
   *
   * Absent means one call per record, which is the whole cost model of a
   * per-record source and the one thing a person choosing a cadence has to
   * know before they choose it. It travels on the preview rather than being
   * looked up separately because the preview is already the moment the form
   * learns what this action can do.
   */
  batch: z.object({ maxItems: z.number() }).optional(),
  /**
   * How the match would go, on the rows just read. Present only when the
   * request named a collection, a match column and a path.
   *
   * `found` is out of `sampled`, not out of the collection: 3 of 20 is not a
   * bad key, it is 20 rows of an app whose list is wider than the team's
   * table. `found: 0` is the one that means the key does not line up.
   */
  matched: z.object({ sampled: z.number(), found: z.number() }).optional(),
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
  missingCount: z.number(),
  unmatchedCount: z.number(),
  upstreamCalls: z.number(),
  truncated: z.boolean(),
  /** Continuations this run took. `1` is a run that finished in one go. */
  legs: z.number(),
  /** Why it stopped short, when it did — the word the UI badges. */
  stopReason: z
    .enum([
      "rate_limited",
      "deadline",
      "row_cap",
      "page_cap",
      "call_cap",
      "unpaged",
      "orphan_floor",
      "legs_cap",
      "no_match_keys",
    ])
    .nullable(),
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
  matchFieldKey: z.string().nullable(),
  /**
   * How this source reads its app — derived, never stored, and the number the
   * cost line is built on.
   */
  read: z.enum(["walk", "row"]),
  /**
   * `true` when the app tells us it changed instead of waiting for the next
   * tick (`manifest.notifiesChanges`). Read by the cadence line and by nothing
   * else: it makes "Once a day" honest by adding ", and whenever <app> tells
   * us", and a source still runs on its schedule either way.
   */
  notifiesChanges: z.boolean(),
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
   * A run hit the orphan floor and applied nothing. Carries the sentence the
   * banner shows and the reason a person needs before confirming a full
   * resync — which is the only thing that clears it.
   */
  pendingFullResync: z
    .object({ requestedAt: z.string(), reason: z.string() })
    .nullable(),
  /** True when the action takes a `{"$since"}` bound and the source binds it. */
  incremental: z.boolean(),
  /** When the source last walked every row, so the diff could be trusted. */
  lastFullWalkAt: z.string().nullable(),
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
