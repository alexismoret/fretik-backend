import type { CollectionSyncSource, FieldDefinition } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import {
  SYNC_LIMITS,
  type SyncRunCounts,
  type SyncStopReason,
  type TableWalkCheckpoint,
} from "../../schemas/collection-sync";
import {
  bulkCreateCollectionRecords,
  type BulkCreateRow,
} from "../collection-records/bulk-create";
import { bulkUpdateCollectionRecords } from "../collection-records/bulk-update";
import { reconcileFieldIndexes } from "../collection-schema/reconcile-indexes";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { syncActor } from "./agent-key";
import { projectRow } from "./project-row";
import {
  type RecordSyncStateWrite,
  touchRecordSyncState,
  upsertRecordSyncState,
  type WalkIndexEntry,
} from "./record-state";
import type { SyncReadAction } from "./resolve-action";
import { walkPages } from "./walk-read";

/**
 * One walk of an app's list, page by page — the engine BOTH walked kinds run on.
 *
 *   for each page the walker yields →
 *     project → ask Postgres which records those keys belong to → partition
 *     into new / changed / unchanged → write → stamp
 *   then, and only after a FULL walk: whatever the resolver does with the rows
 *   this walk did not see.
 *
 * Two properties fall out of doing it page-wise rather than collecting first.
 * The run holds one page, never the collection — the first version's in-memory
 * index of a million rows was 150-200 MB and did not survive a resume in
 * another process. And a run that stops half way has ALREADY WRITTEN what it
 * read, so the next leg resumes from a checkpoint instead of re-asking the
 * third party for everything.
 *
 * WHAT THE RESOLVER DECIDES, and the only things it decides: how a row is
 * KEYED, which records that key belongs to, what to do with a key that belongs
 * to none, and what a completed full walk owes the rows it did not see. A
 * `table` source keys on the upstream id, creates what it has never seen, and
 * runs the orphan bracket; a `columns` source keys on one of the collection's
 * own columns, ignores what it cannot match, and marks the unseen `missing`.
 * Everything between those four points — the paging, the budgets, the
 * checkpoint, the hash diff, the chunked writes, the state stamps — is written
 * once, here.
 *
 * Two invariants it never breaks, both by construction rather than by care:
 *  - it writes ONLY the columns this source owns (`fieldMapping` ∩ fields whose
 *    `syncSourceId` is this source), so a user's local column on a synced
 *    collection survives every run — which is why the update is `merge: true`
 *    with a data map containing nothing else;
 *  - it never writes `external_app_connections.status`. A third party refusing
 *    this team's credential is this SOURCE's error, not the connection's; see
 *    `resolve-action.ts`.
 */

export type { SyncRunCounts };

export const emptyCounts = (): SyncRunCounts => ({
  createdCount: 0,
  updatedCount: 0,
  unchangedCount: 0,
  orphanCount: 0,
  failedCount: 0,
  missingCount: 0,
  unmatchedCount: 0,
  upstreamCalls: 0,
  truncated: false,
});

/**
 * How a walk ended.
 *
 *  - `complete`  : every row walked and reconciled. The only outcome that
 *                  stamps `last_success_at`.
 *  - `suspended` : a budget bit and the walk has somewhere to resume from.
 *  - `floor`     : the walk finished, and the diff was too large to believe.
 *  - `skipped`   : the resolver answered before the first call that there was
 *                  nothing to walk FOR. Not a failure and not a truncation —
 *                  a run that correctly cost nothing.
 */
export type WalkSyncOutcome =
  | { kind: "complete"; counts: SyncRunCounts }
  | {
      kind: "suspended";
      counts: SyncRunCounts;
      checkpoint: TableWalkCheckpoint;
      reason: SyncStopReason;
      retryAfterMs?: number;
    }
  | { kind: "floor"; counts: SyncRunCounts; reason: string }
  | { kind: "skipped"; counts: SyncRunCounts; reason: SyncStopReason };

/**
 * The columns a source may write: mapped AND stamped as belonging to it.
 *
 * Both halves, because they can disagree. A field released by an edit keeps its
 * key, so a stale mapping entry would still name a column the source no longer
 * owns — and writing it would overwrite whatever a user has typed into it since
 * it became theirs.
 */
export const ownedFields = (
  source: Pick<CollectionSyncSource, "id" | "fieldMapping">,
  fieldDefs: readonly FieldDefinition[],
): FieldDefinition[] => {
  const mapped = new Set(source.fieldMapping.map((entry) => entry.fieldKey));
  return fieldDefs.filter(
    (field) => mapped.has(field.key) && field.syncSourceId === source.id,
  );
};

/** What a completed full walk owes the rows it did not see. */
export interface AfterFullWalkInput {
  walkStartedAt: Date;
  ignoreOrphanFloor: boolean;
  counts: SyncRunCounts;
}

export interface WalkResolver {
  /** This row's key, or `undefined` when it carries none. */
  keyOf: (row: Record<string, unknown>) => string | undefined;
  /**
   * Which records each key belongs to. A LIST, because a match column is not
   * unique: two records may carry the same reference and both should receive
   * the app's answer.
   */
  resolve: (keys: readonly string[]) => Promise<Map<string, WalkIndexEntry[]>>;
  /**
   * A key belonging to no record. `create` makes one (the source owns the
   * rows); `count` tallies it in `unmatchedCount` and moves on (the team owns
   * the rows, and an app whose list is wider than their table is the normal
   * case, not a problem).
   */
  unknownRows: "create" | "count";
  /**
   * Asked once, before the first call of a FRESH walk — never on a resumed
   * leg, where the calls are already spent and the answer would be stale.
   */
  precheck?: () => Promise<
    { skip: false } | { skip: true; reason: SyncStopReason }
  >;
  /** Once, after a complete full walk. May refuse. */
  afterFullWalk: (
    input: AfterFullWalkInput,
  ) => Promise<{ kind: "applied" } | { kind: "floor"; reason: string }>;
}

export type WalkResolverFactory = (ctx: {
  source: CollectionSyncSource;
  fieldDefs: readonly FieldDefinition[];
  fields: FieldDefinition[];
  actor: ReturnType<typeof syncActor>;
}) => WalkResolver;

/**
 * Which stop reasons are worth resuming.
 *
 * `row_cap` and `unpaged` are NOT: the first is the source's own ceiling, so
 * walking past it on the next leg would be ignoring the setting, and the second
 * says the action cannot be asked for a second page at all. Both end the run
 * `partial` and truncated, which is what they have always meant.
 */
const RESUMABLE: ReadonlySet<SyncStopReason> = new Set<SyncStopReason>([
  "deadline",
  "rate_limited",
  "page_cap",
  "call_cap",
]);

export interface RunWalkSyncInput {
  source: CollectionSyncSource;
  action: SyncReadAction;
  deadlineAt: number;
  /** The run this walk belongs to — one run however many legs it takes. */
  runId: string;
  /** `collection_sync_runs.started_at`, the bracket's boundary. */
  walkStartedAt: Date;
  configHash: string;
  /** Null on the first leg. */
  resume?: TableWalkCheckpoint | null;
  /** True when this walk asks for everything, so its diff may be trusted. */
  fullWalk: boolean;
  /** A confirmed full resync applies the policy however large the diff. */
  ignoreOrphanFloor: boolean;
  resolver: WalkResolverFactory;
}

export const runWalkSync = async (
  input: RunWalkSyncInput,
): Promise<WalkSyncOutcome> => {
  const { source, resume } = input;
  // A checkpoint frozen before a counter existed has no field for it, and
  // `undefined + 1` is `NaN` — which reaches the run row as a failed UPDATE.
  // Spreading over a fresh zeroed set costs nothing and keeps a walk that was
  // in flight across a deploy resumable, where bumping the checkpoint version
  // would have thrown it away.
  const counts: SyncRunCounts = resume
    ? { ...emptyCounts(), ...resume.counts }
    : emptyCounts();

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: source.teamId,
    collectionId: source.collectionId,
  });
  const fields = ownedFields(source, fieldDefs);
  const actor = syncActor(source.id);
  const resolver = input.resolver({ source, fieldDefs, fields, actor });

  if (resume == null && resolver.precheck !== undefined) {
    const verdict = await resolver.precheck();
    if (verdict.skip)
      return { kind: "skipped", counts, reason: verdict.reason };
  }

  // The `{"$since"}` bound is frozen for the WHOLE walk, not recomputed per
  // leg: a second leg binding a fresher `lastSuccessAt` would ask for a
  // narrower window than the first one did and skip everything in between.
  const sinceAt = input.fullWalk
    ? null
    : resume
      ? resume.sinceAt === null
        ? null
        : new Date(resume.sinceAt)
      : source.lastSuccessAt;

  let wroteRecords = false;
  const walk = walkPages({
    action: input.action,
    args: source.args,
    resultPath: source.resultPath,
    lastSuccessAt: sinceAt,
    rowCap: Math.min(source.rowCap, SYNC_LIMITS.maxRowCap),
    deadlineAt: input.deadlineAt,
    ...(resume
      ? {
          resumeFrom: resume.position,
          rowsSeen: resume.rowsSeen,
          calls: resume.calls,
          pagesDone: resume.pagesDone,
        }
      : {}),
  });

  let rowsSeen = resume?.rowsSeen ?? 0;
  let pagesDone = resume?.pagesDone ?? 0;

  for (;;) {
    const step = await walk.next();

    if (step.done === true) {
      const stop = step.value;
      if (stop !== undefined && RESUMABLE.has(stop.reason)) {
        counts.truncated = true;
        return {
          kind: "suspended",
          counts,
          reason: stop.reason,
          checkpoint: {
            version: 1,
            runId: input.runId,
            walkStartedAt: input.walkStartedAt.toISOString(),
            configHash: input.configHash,
            sinceAt: sinceAt?.toISOString() ?? null,
            position: stop.next,
            rowsSeen,
            calls: counts.upstreamCalls,
            pagesDone,
            legs: (resume?.legs ?? 1) + 1,
            counts,
            ignoreOrphanFloor: input.ignoreOrphanFloor,
            fullWalk: input.fullWalk,
          },
          ...(stop.retryAfterMs !== undefined
            ? { retryAfterMs: stop.retryAfterMs }
            : {}),
        };
      }
      // Not resumable: the walk is as finished as it will ever be. A truncated
      // one still skips the reconcile — see below.
      if (stop !== undefined) counts.truncated = true;
      break;
    }

    const page = step.value;
    counts.upstreamCalls = page.calls;
    rowsSeen = page.rowsSeen;
    pagesDone = page.pagesDone;
    const wrote = await absorbPage({
      source,
      fields,
      actor,
      rows: page.rows,
      resolver,
      counts,
    });
    if (wrote) wroteRecords = true;
  }

  // A TRUNCATED walk saw part of the answer, and an INCREMENTAL one saw only
  // what changed. Neither can say "this row is gone", so neither reconciles.
  // The incremental half is the subtler of the two and the more dangerous: for
  // a `table` source under `delete` it would empty the collection on the second
  // run, which is exactly what a filter-narrowing looks like from here.
  const mayReconcile = !counts.truncated && input.fullWalk;
  if (mayReconcile) {
    const verdict = await resolver.afterFullWalk({
      walkStartedAt: input.walkStartedAt,
      ignoreOrphanFloor: input.ignoreOrphanFloor,
      counts,
    });
    if (verdict.kind === "floor") {
      afterWrites(source, wroteRecords);
      return { kind: "floor", counts, reason: verdict.reason };
    }
  }

  afterWrites(source, wroteRecords);
  return { kind: "complete", counts };
};

/**
 * One page: project, resolve against Postgres, write. Returns true if it wrote
 * records (so the run knows whether the indexes need reconciling at the end).
 */
const absorbPage = async (ctx: {
  source: CollectionSyncSource;
  fields: FieldDefinition[];
  actor: ReturnType<typeof syncActor>;
  rows: Record<string, unknown>[];
  resolver: WalkResolver;
  counts: SyncRunCounts;
}): Promise<boolean> => {
  const { source, counts, resolver } = ctx;

  // Last one wins on a repeated key WITHIN a page. A provider whose pages
  // overlap (an offset walk over a list something is being inserted into) can
  // still send the same key in two different pages; the second one then finds
  // the record the first created and updates it, which is the right answer and
  // costs one resolve query.
  const projected = new Map<
    string,
    { data: Record<string, unknown>; hash: string }
  >();
  for (const row of ctx.rows) {
    const key = resolver.keyOf(row);
    if (key === undefined || key === "") {
      // A keyless row means different things to the two resolvers, and both
      // are counted rather than dropped in silence. Owning the rows, it is a
      // row that could only ever be duplicated — a defect. Matching them, it
      // is simply a row about something this collection does not track.
      if (resolver.unknownRows === "create") counts.failedCount += 1;
      else counts.unmatchedCount += 1;
      continue;
    }
    projected.set(
      key,
      projectRow({ row, mapping: source.fieldMapping, fields: ctx.fields }),
    );
  }
  if (projected.size === 0) return false;

  const index = await resolver.resolve([...projected.keys()]);

  const toCreate: {
    externalId: string;
    data: Record<string, unknown>;
    hash: string;
  }[] = [];
  const toUpdate: {
    recordId: string;
    data: Record<string, unknown>;
    hash: string;
  }[] = [];
  const unchanged: string[] = [];

  for (const [key, row] of projected) {
    const existing = index.get(key) ?? [];
    if (existing.length === 0) {
      if (resolver.unknownRows === "count") {
        counts.unmatchedCount += 1;
        continue;
      }
      toCreate.push({ externalId: key, ...row });
      continue;
    }
    for (const entry of existing) {
      // An identical hash is only "unchanged" when the last attempt SUCCEEDED.
      // A row with no state (a run that died between the record and its state)
      // or one marked `missing`/`error` is re-written even though its values
      // match: the cheap thing here is skipping the UPDATE, and skipping the
      // state row too would leave the record permanently invisible to the next
      // reconcile — and, for a matched source, permanently `missing` while the
      // app has been answering about it all along.
      if (entry.contentHash === row.hash && entry.status === "ok") {
        unchanged.push(entry.recordId);
        continue;
      }
      toUpdate.push({ recordId: entry.recordId, ...row });
    }
  }

  const state: RecordSyncStateWrite[] = [];

  for (const batch of chunkForBulk(toCreate, SYNC_LIMITS.walkPageWriteChunk)) {
    const rows: BulkCreateRow[] = batch.map((row) => ({
      data: row.data,
      externalId: row.externalId,
    }));
    const created = await bulkCreateCollectionRecords({
      organizationId: source.organizationId,
      teamId: source.teamId,
      collectionId: source.collectionId,
      rows,
      source: "connector",
      syncSourceId: source.id,
      allowSyncedFields: true,
      // The indexes are built ONCE at the end of the run, not per chunk: a
      // `CREATE INDEX CONCURRENTLY` per chunk would run against the table while
      // the load is still going. Measured on 500k rows in `bulk-create.ts`:
      // load-then-index is 1.8× faster for the same end state.
      skipIndexReconcile: true,
      actor: ctx.actor,
    });
    created.ids.forEach((recordId, i) => {
      const row = batch[i];
      if (recordId === null || row === undefined) {
        counts.failedCount += 1;
        return;
      }
      counts.createdCount += 1;
      state.push({ recordId, status: "ok", contentHash: row.hash });
    });
  }

  for (const batch of chunkForBulk(toUpdate, SYNC_LIMITS.walkPageWriteChunk)) {
    const result = await bulkUpdateCollectionRecords({
      teamId: source.teamId,
      // `merge: true` with a data map holding ONLY this source's keys is what
      // makes a local column survive. A full replace would clear every column
      // the app does not know about, which on a CRM is somebody's notes.
      merge: true,
      allowSyncedFields: true,
      updates: batch.map((row) => ({ id: row.recordId, data: row.data })),
      actor: ctx.actor,
    });
    const failed = new Map(result.errors.map((e) => [e.id, e.error]));
    for (const row of batch) {
      const error = failed.get(row.recordId);
      if (error !== undefined) {
        counts.failedCount += 1;
        state.push({
          recordId: row.recordId,
          status: "error",
          error,
          failed: true,
        });
        continue;
      }
      counts.updatedCount += 1;
      state.push({
        recordId: row.recordId,
        status: "ok",
        contentHash: row.hash,
      });
    }
  }

  await upsertRecordSyncState(source.id, state);
  // The unchanged rows: no record write, no journal entry, one timestamp — the
  // mark the reconcile reads. Written AFTER the upsert so a row that appears in
  // both (it cannot, but the ordering is free) ends up stamped.
  await touchRecordSyncState(source.id, unchanged);
  counts.unchangedCount += unchanged.length;

  return toCreate.length > 0 || toUpdate.length > 0;
};

/**
 * Once, after the load. Not awaited — `CREATE INDEX CONCURRENTLY` scales with
 * the table and the rows are already committed and readable without it.
 */
const afterWrites = (source: CollectionSyncSource, wrote: boolean): void => {
  if (!wrote) return;
  void reconcileFieldIndexes({ collectionId: source.collectionId }).catch(
    (cause: unknown) => {
      console.warn(
        `[collection-sync] index reconcile skipped for ${source.collectionId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    },
  );
};
