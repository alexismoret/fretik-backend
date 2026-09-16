import type { CollectionSyncSource, FieldDefinition } from "../../db/schema";
import { chunkForBulk, MAX_BULK_ITEMS } from "../../lib/db-bulk";
import {
  bulkCreateCollectionRecords,
  type BulkCreateRow,
} from "../collection-records/bulk-create";
import { bulkUpdateCollectionRecords } from "../collection-records/bulk-update";
import { reconcileFieldIndexes } from "../collection-schema/reconcile-indexes";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { syncActor } from "./agent-key";
import { applyOrphanPolicy } from "./apply-orphans";
import { projectRow, readPath } from "./project-row";
import {
  loadTableSyncIndex,
  type RecordSyncStateWrite,
  upsertRecordSyncState,
} from "./record-state";
import type { SyncReadAction } from "./resolve-action";
import { walkRead } from "./walk-read";

/**
 * One run of a `table` source: the upstream list becomes the collection.
 *
 * The shape is the plan's §3.4, and every step of it exists to make the SECOND
 * run cheap:
 *
 *   walk → project → load this source's state in ONE query → partition into
 *   new / changed / unchanged / missing → create the new → merge the changed →
 *   apply the orphan policy → write the state set-based → index once at the end
 *
 * The partition is the whole point. An hourly sync of 10 000 rows where nothing
 * moved writes NOTHING: no UPDATE, so no `domain_events`, so no record-card
 * re-embedding and no workflow-trigger candidates. Without the hash the same
 * run would rewrite the collection every hour and re-embed it every hour, which
 * is the cost that decides whether this feature is affordable at all.
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

export interface SyncRunCounts {
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  orphanCount: number;
  failedCount: number;
  upstreamCalls: number;
  truncated: boolean;
}

export const emptyCounts = (): SyncRunCounts => ({
  createdCount: 0,
  updatedCount: 0,
  unchangedCount: 0,
  orphanCount: 0,
  failedCount: 0,
  upstreamCalls: 0,
  truncated: false,
});

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

export const runTableSync = async (input: {
  source: CollectionSyncSource;
  action: SyncReadAction;
  deadlineAt: number;
}): Promise<SyncRunCounts> => {
  const { source } = input;
  const counts = emptyCounts();
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

  const walk = await walkRead({
    action: input.action,
    args: source.args,
    resultPath: source.resultPath,
    lastSuccessAt: source.lastSuccessAt,
    rowCap: source.rowCap,
    deadlineAt: input.deadlineAt,
  });
  counts.upstreamCalls = walk.calls;
  counts.truncated = walk.truncated;

  // Last one wins on a repeated id. A provider whose pages overlap (an offset
  // walk over a list something is being inserted into) would otherwise send the
  // same id twice, and both halves of the diff would claim it.
  const projected = new Map<
    string,
    { data: Record<string, unknown>; hash: string }
  >();
  for (const row of walk.rows) {
    const rawId = readPath(row, externalIdPath);
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
      projectRow({ row, mapping: source.fieldMapping, fields }),
    );
  }

  const index = await loadTableSyncIndex(source.id);
  const actor = syncActor(source.id);

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

  // A TRUNCATED walk saw part of the answer, so "not in the answer" does not
  // mean "gone upstream" — applying the orphan policy here would reject or
  // delete every row past the cap. The one case where doing nothing is right.
  const orphans = walk.truncated
    ? []
    : [...index.entries()]
        .filter(([externalId]) => !projected.has(externalId))
        .map(([, entry]) => entry);

  const state: RecordSyncStateWrite[] = [];

  for (const batch of chunkForBulk(toCreate, MAX_BULK_ITEMS)) {
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
      actor,
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

  for (const batch of chunkForBulk(toUpdate, MAX_BULK_ITEMS)) {
    const result = await bulkUpdateCollectionRecords({
      teamId: source.teamId,
      // `merge: true` with a data map holding ONLY this source's keys is what
      // makes a local column survive. A full replace would clear every column
      // the app does not know about, which on a CRM is somebody's notes.
      merge: true,
      allowSyncedFields: true,
      updates: batch.map((row) => ({ id: row.recordId, data: row.data })),
      actor,
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

  counts.unchangedCount = unchanged.length;
  await upsertRecordSyncState(source.id, state);

  counts.orphanCount = await applyOrphanPolicy({
    organizationId: source.organizationId,
    teamId: source.teamId,
    syncSourceId: source.id,
    policy: source.orphanPolicy,
    recordIds: orphans.map((entry) => entry.recordId),
    actor,
  });

  // Once, after the load. Not awaited inside `bulkCreate` (it is skipped there)
  // and not awaited here either — `CREATE INDEX CONCURRENTLY` scales with the
  // table and the rows are already committed and readable without it.
  if (counts.createdCount > 0 || counts.updatedCount > 0) {
    void reconcileFieldIndexes({ collectionId: source.collectionId }).catch(
      (cause: unknown) => {
        console.warn(
          `[collection-sync] index reconcile skipped for ${source.collectionId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      },
    );
  }

  return counts;
};
