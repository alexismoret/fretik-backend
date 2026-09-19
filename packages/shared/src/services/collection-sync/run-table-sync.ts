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
import { applyOrphanPolicy } from "./apply-orphans";
import {
  countNewOrphans,
  hitsOrphanFloor,
  listOrphanIds,
  orphanFloorReason,
} from "./orphan-bracket";
import { projectRow, readPath } from "./project-row";
import {
  loadTableSyncIndexFor,
  type RecordSyncStateWrite,
  touchRecordSyncState,
  upsertRecordSyncState,
} from "./record-state";
import type { SyncReadAction } from "./resolve-action";
import { walkPages } from "./walk-read";

/**
 * One run of a `table` source: the upstream list becomes the collection.
 *
 * PAGE BY PAGE, which is the shape of everything below:
 *
 *   for each page the walker yields →
 *     project → ask Postgres about THOSE ids → partition into new / changed /
 *     unchanged → create the new → merge the changed → stamp the unchanged
 *   then, and only after a FULL walk: count the orphans, check the floor,
 *   apply the policy in pages
 *
 * Two properties fall out of doing it this way rather than collecting first.
 * The run holds one page, never the collection — the old version's in-memory
 * index of a million rows was 150-200 MB and did not survive a resume in
 * another process. And a run that stops half way has ALREADY WRITTEN what it
 * read, so the next leg resumes from a checkpoint instead of re-asking the
 * third party for everything.
 *
 * The content hash still does the work it always did: an hourly sync of 10 000
 * rows where nothing moved writes no record UPDATE, so no `domain_events`, so
 * no record-card re-embedding and no workflow-trigger candidates. What page-wise
 * working adds is one `UPDATE … SET synced_at` per page of unchanged rows,
 * which is what the orphan bracket reads and the cheapest possible mark.
 *
 * Two invariants it never breaks, both enforced by construction rather than by
 * care:
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
  upstreamCalls: 0,
  truncated: false,
});

/** Orphan ids taken per page when the policy is applied. */
const ORPHAN_PAGE = 2_000;

/**
 * How a `table` run ended.
 *
 *  - `complete`  : every row walked and diffed. The only outcome that stamps
 *                  `last_success_at`.
 *  - `suspended` : a budget bit and the walk has somewhere to resume from.
 *  - `floor`     : the walk finished, and the diff was too large to believe.
 */
export type TableSyncOutcome =
  | { kind: "complete"; counts: SyncRunCounts }
  | {
      kind: "suspended";
      counts: SyncRunCounts;
      checkpoint: TableWalkCheckpoint;
      reason: SyncStopReason;
      retryAfterMs?: number;
    }
  | {
      kind: "floor";
      counts: SyncRunCounts;
      reason: string;
    };

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

export const runTableSync = async (input: {
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
}): Promise<TableSyncOutcome> => {
  const { source, resume } = input;
  const counts = resume ? { ...resume.counts } : emptyCounts();
  const externalIdPath = source.externalIdPath;
  if (externalIdPath === null || externalIdPath === "") {
    // The create schema refuses this, so reaching it means a row was written
    // around the service. Failing loudly beats duplicating the collection.
    throw new Error(
      "this table source has no externalIdPath — without a stable upstream id every run would duplicate the collection",
    );
  }

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: source.teamId,
    collectionId: source.collectionId,
  });
  const fields = ownedFields(source, fieldDefs);
  const actor = syncActor(source.id);

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
      // one still skips the diff — see below.
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
      externalIdPath,
      counts,
    });
    if (wrote) wroteRecords = true;
  }

  // A TRUNCATED walk saw part of the answer, and an INCREMENTAL one saw only
  // what changed. Neither can say "this row is gone", so neither diffs. The
  // incremental half is the subtler of the two and the more dangerous: under
  // `delete` it would empty the collection on the second run, which is exactly
  // what a filter-narrowing looks like from here.
  const mayDiff = !counts.truncated && input.fullWalk;
  if (mayDiff) {
    const census = await countNewOrphans({
      syncSourceId: source.id,
      walkStartedAt: input.walkStartedAt,
    });
    if (!input.ignoreOrphanFloor && hitsOrphanFloor(census)) {
      afterWrites(source, wroteRecords);
      return { kind: "floor", counts, reason: orphanFloorReason(census) };
    }
    counts.orphanCount = await applyOrphans({
      source,
      walkStartedAt: input.walkStartedAt,
      actor,
    });
  }

  afterWrites(source, wroteRecords);
  return { kind: "complete", counts };
};

/**
 * One page: project, diff against Postgres, write. Returns true if it wrote
 * records (so the run knows whether the indexes need reconciling at the end).
 */
const absorbPage = async (ctx: {
  source: CollectionSyncSource;
  fields: FieldDefinition[];
  actor: ReturnType<typeof syncActor>;
  rows: Record<string, unknown>[];
  externalIdPath: string;
  counts: SyncRunCounts;
}): Promise<boolean> => {
  const { source, counts } = ctx;

  // Last one wins on a repeated id WITHIN a page. A provider whose pages
  // overlap (an offset walk over a list something is being inserted into) can
  // still send the same id in two different pages; the second one then finds
  // the record the first created and updates it, which is the right answer and
  // costs one diff query.
  const projected = new Map<
    string,
    { data: Record<string, unknown>; hash: string }
  >();
  for (const row of ctx.rows) {
    const rawId = readPath(row, ctx.externalIdPath);
    const externalId =
      typeof rawId === "string"
        ? rawId
        : typeof rawId === "number" && Number.isFinite(rawId)
          ? String(rawId)
          : undefined;
    if (externalId === undefined || externalId === "") {
      // A row with no id cannot be updated on any later run, only duplicated.
      // Counted so the run says how many, and dropped.
      counts.failedCount += 1;
      continue;
    }
    projected.set(
      externalId,
      projectRow({ row, mapping: source.fieldMapping, fields: ctx.fields }),
    );
  }
  if (projected.size === 0) return false;

  const index = await loadTableSyncIndexFor(source.id, [...projected.keys()]);

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

  for (const [externalId, row] of projected) {
    const existing = index.get(externalId);
    if (existing === undefined) {
      toCreate.push({ externalId, ...row });
      continue;
    }
    // An identical hash is only "unchanged" when the last attempt SUCCEEDED. A
    // row with no state (a run that died between the record and its state) or
    // one marked `missing`/`error` is re-written even though its values match:
    // the cheap thing here is skipping the UPDATE, and skipping the state row
    // too would leave the record permanently invisible to the next diff.
    if (existing.contentHash === row.hash && existing.status === "ok") {
      unchanged.push(existing.recordId);
      continue;
    }
    toUpdate.push({ recordId: existing.recordId, ...row });
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
  // mark the orphan bracket reads. Written AFTER the upsert so a row that
  // appears in both (it cannot, but the ordering is free) ends up stamped.
  await touchRecordSyncState(source.id, unchanged);
  counts.unchangedCount += unchanged.length;

  return toCreate.length > 0 || toUpdate.length > 0;
};

/** Apply the policy to every orphan, a page of ids at a time. */
const applyOrphans = async (ctx: {
  source: CollectionSyncSource;
  walkStartedAt: Date;
  actor: ReturnType<typeof syncActor>;
}): Promise<number> => {
  let applied = 0;
  let after: string | null = null;
  for (;;) {
    const ids: string[] = await listOrphanIds({
      syncSourceId: ctx.source.id,
      walkStartedAt: ctx.walkStartedAt,
      after,
      limit: ORPHAN_PAGE,
    });
    if (ids.length === 0) return applied;
    applied += await applyOrphanPolicy({
      organizationId: ctx.source.organizationId,
      teamId: ctx.source.teamId,
      syncSourceId: ctx.source.id,
      policy: ctx.source.orphanPolicy,
      recordIds: ids,
      actor: ctx.actor,
    });
    // `keep` and `reject` leave the row in place with `status = 'missing'`, so
    // the query that found it no longer will — but `delete` removes it and
    // `keep` on a row that was already `missing` is a no-op. The cursor is what
    // makes all three terminate: it only ever moves forward.
    after = ids[ids.length - 1] ?? null;
    if (ids.length < ORPHAN_PAGE) return applied;
  }
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
