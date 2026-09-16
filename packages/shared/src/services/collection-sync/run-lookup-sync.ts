import { sql } from "drizzle-orm";
import db from "../../db";
import type {
  CollectionSyncSource,
  ExternalAppConnection,
} from "../../db/schema";
import { chunkForBulk, MAX_BULK_ITEMS } from "../../lib/db-bulk";
import { isSyncFieldBinding, SYNC_LIMITS } from "../../schemas/collection-sync";
import { bulkUpdateCollectionRecords } from "../collection-records/bulk-update";
import { readRecordDataBatch } from "../collection-schema/record-io";
import { isSerialConnection } from "../external-apps/exec/connection-slot";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { syncActor } from "./agent-key";
import { projectRow, readPath } from "./project-row";
import {
  loadRecordSyncState,
  type RecordSyncStateWrite,
  upsertRecordSyncState,
} from "./record-state";
import type { SyncReadAction } from "./resolve-action";
import { resolveSyncArgs } from "./resolve-args";
import { emptyCounts, ownedFields, type SyncRunCounts } from "./run-table-sync";
import { extractRows } from "./walk-read";

/**
 * One run of a `lookup` source: some COLUMNS of records the source does not
 * own, filled per record from its own key.
 *
 * This is the N+1 the plan calls the real difficulty (§0.5), and the three
 * answers to it are all here:
 *
 *  1. A BOUNDED WORK LIST. A run refreshes at most
 *     `SYNC_LIMITS.lookupBatchSize` records, picked in the order a person would
 *     pick them: the ones someone just asked for, then the ones an edit marked
 *     `pending`, then the stalest, then the ones never done. A collection of
 *     50 000 records is therefore refreshed progressively and never in one
 *     catastrophic pass.
 *  2. `batch` WHEN THE API HAS IT. One call for twenty records instead of
 *     twenty calls, which is the only structural fix — everything else is
 *     rationing.
 *  3. NO CALL AT ALL when the answer is already known. A record with no value
 *     for the bound key cannot be looked up, so it is marked `missing` and
 *     skipped without spending anything; and a record whose answer hashes to
 *     what is already stored costs no UPDATE, no journal entry and no
 *     re-embedding.
 */

/** Concurrent calls on a connection the provider does not declare `serial`. */
const PARALLEL_CALLS = 4;

interface Candidate {
  recordId: string;
  contentHash: string | null;
}

export const runLookupSync = async (input: {
  source: CollectionSyncSource;
  connection: ExternalAppConnection;
  action: SyncReadAction;
  deadlineAt: number;
  /** Records the caller named — refreshed before anything else. */
  recordIds?: string[];
}): Promise<SyncRunCounts> => {
  const { source, action } = input;
  const counts = emptyCounts();

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: source.teamId,
    collectionId: source.collectionId,
  });
  const fields = ownedFields(source, fieldDefs);
  if (fields.length === 0) return counts;

  const candidates = await selectCandidates({
    source,
    ...(input.recordIds !== undefined ? { requested: input.recordIds } : {}),
  });
  if (candidates.length === 0) return counts;

  const data = await readRecordDataBatch({
    collectionId: source.collectionId,
    recordIds: candidates.map((candidate) => candidate.recordId),
    fields: fieldDefs,
  });

  const state: RecordSyncStateWrite[] = [];
  const askable: { candidate: Candidate; args: Record<string, unknown> }[] = [];
  for (const candidate of candidates) {
    const { args, missingFieldKeys } = resolveSyncArgs({
      args: source.args,
      since: null,
      ...(action.incremental !== undefined
        ? { incremental: action.incremental }
        : {}),
      fieldValues: data.get(candidate.recordId) ?? {},
    });
    if (missingFieldKeys.length > 0) {
      // Not an error and not retried: there is nothing to ask. The journal
      // sweep marks this record `pending` the moment somebody fills the key,
      // which is what makes a lookup column feel live.
      state.push({
        recordId: candidate.recordId,
        status: "missing",
        error: `no value for ${missingFieldKeys.join(", ")}`,
      });
      continue;
    }
    askable.push({ candidate, args });
  }

  const answers = new Map<string, unknown>();
  const batchPath = batchBinding(source, action);
  if (batchPath !== undefined) {
    await callBatched({
      source,
      action,
      askable,
      answers,
      counts,
      input,
      batchPath,
    });
  } else {
    await callOneByOne({
      action,
      resultPath: source.resultPath,
      askable,
      answers,
      counts,
      input,
      state,
    });
  }

  const updates: {
    recordId: string;
    data: Record<string, unknown>;
    hash: string;
  }[] = [];
  for (const { candidate } of askable) {
    if (!answers.has(candidate.recordId)) continue;
    const row = answers.get(candidate.recordId);
    const projection = projectRow({
      row,
      mapping: source.fieldMapping,
      fields,
    });
    if (projection.hash === candidate.contentHash) {
      counts.unchangedCount += 1;
      continue;
    }
    updates.push({ recordId: candidate.recordId, ...projection });
  }

  for (const batch of chunkForBulk(updates, MAX_BULK_ITEMS)) {
    const result = await bulkUpdateCollectionRecords({
      teamId: source.teamId,
      // Only this source's keys, merged: the rest of the record belongs to its
      // own collection and to whoever has been editing it.
      merge: true,
      allowSyncedFields: true,
      updates: batch.map((row) => ({ id: row.recordId, data: row.data })),
      actor: syncActor(source.id),
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

  // An unchanged row still gets its state written: `synced_at` is the rotation
  // order, and leaving it where it was would hand the same records to the next
  // run forever while the rest of the collection never got its turn.
  const written = new Set(updates.map((row) => row.recordId));
  for (const { candidate } of askable) {
    if (!answers.has(candidate.recordId)) continue;
    if (written.has(candidate.recordId)) continue;
    state.push({
      recordId: candidate.recordId,
      status: "ok",
      contentHash: candidate.contentHash,
    });
  }

  await upsertRecordSyncState(source.id, state);
  return counts;
};

/**
 * The work list, in ONE query.
 *
 * `missing` rows are excluded from the automatic rotation on purpose: they have
 * no key, so re-asking every run would burn the budget on records whose answer
 * cannot change until somebody edits them — and when somebody does, the journal
 * sweep marks them `pending`, which is the first bucket below.
 */
const selectCandidates = async (input: {
  source: CollectionSyncSource;
  requested?: string[];
}): Promise<Candidate[]> => {
  const limit = SYNC_LIMITS.lookupBatchSize;
  const requested = (input.requested ?? []).slice(0, limit);
  const picked = new Map<string, Candidate>();

  if (requested.length > 0) {
    const stateByRecord = await loadRecordSyncState(input.source.id);
    const owned = await db.execute(sql`
      SELECT id::text AS id FROM collection_records
       WHERE id = ANY(${sql.param(requested)}::uuid[])
         AND team_id = ${input.source.teamId}::uuid
         AND collection_id = ${input.source.collectionId}::uuid`);
    for (const row of owned.rows) {
      const recordId = Reflect.get(row, "id");
      if (typeof recordId !== "string") continue;
      picked.set(recordId, {
        recordId,
        contentHash: stateByRecord.get(recordId)?.contentHash ?? null,
      });
    }
  }
  if (picked.size >= limit) return [...picked.values()];

  const result = await db.execute(sql`
    SELECT r.id::text     AS id,
           s.content_hash AS content_hash
      FROM collection_records r
      LEFT JOIN record_sync_state s
             ON s.record_id = r.id
            AND s.sync_source_id = ${input.source.id}::uuid
     WHERE r.collection_id = ${input.source.collectionId}::uuid
       AND r.team_id = ${input.source.teamId}::uuid
       AND r.status <> 'rejected'::ontology_status
       AND (s.status IS NULL OR s.status <> 'missing'::record_sync_status)
     ORDER BY CASE
                WHEN s.status = 'pending'::record_sync_status THEN 0
                WHEN s.record_id IS NOT NULL THEN 1
                ELSE 2
              END,
              s.synced_at ASC
     LIMIT ${limit}`);
  for (const row of result.rows) {
    if (picked.size >= limit) break;
    const recordId = Reflect.get(row, "id");
    if (typeof recordId !== "string" || picked.has(recordId)) continue;
    const contentHash = Reflect.get(row, "content_hash");
    picked.set(recordId, {
      recordId,
      contentHash: typeof contentHash === "string" ? contentHash : null,
    });
  }
  return [...picked.values()];
};

/**
 * The argument this action batches over, when it can be batched at all.
 *
 * Three things must line up: the action declares `batch`, the source binds that
 * very parameter to a record field, and there is a path in the ANSWER that
 * carries the same value back — without the third, N answers cannot be re-keyed
 * to N records and batching would silently assign one company's data to
 * another. `externalIdPath` is where a user names that path; failing that, the
 * batch parameter's own name is the convention most APIs follow (`ids` in,
 * `id` on each row).
 */
const batchBinding = (
  source: CollectionSyncSource,
  action: SyncReadAction,
): { param: string; maxItems: number; answerPath: string } | undefined => {
  const batch = action.batch;
  if (batch === undefined) return undefined;
  const bound = source.args[batch.param];
  if (bound === undefined || !isSyncFieldBinding(bound)) return undefined;
  const answerPath =
    source.externalIdPath !== null && source.externalIdPath !== ""
      ? source.externalIdPath
      : batch.param.replace(/s$/, "");
  return { param: batch.param, maxItems: batch.maxItems, answerPath };
};

const callBatched = async (ctx: {
  source: CollectionSyncSource;
  action: SyncReadAction;
  askable: { candidate: Candidate; args: Record<string, unknown> }[];
  answers: Map<string, unknown>;
  counts: SyncRunCounts;
  input: { deadlineAt: number };
  batchPath: { param: string; maxItems: number; answerPath: string };
}): Promise<void> => {
  const { batchPath } = ctx;
  // Bound value → record. Several records may share one key (two rows for the
  // same company), and all of them get the answer.
  const byValue = new Map<string, string[]>();
  for (const { candidate, args } of ctx.askable) {
    const key = scalarKey(args[batchPath.param]);
    if (key === undefined) continue;
    byValue.set(key, [...(byValue.get(key) ?? []), candidate.recordId]);
  }
  // The literal arguments ONLY. Taking record zero's resolved args would carry
  // its own value for every other `$field` binding into a call made on behalf
  // of nineteen other records — the exact mix-up batching has to avoid.
  const literals = resolveSyncArgs({ args: ctx.source.args, since: null }).args;

  for (const group of chunkForBulk([...byValue.keys()], batchPath.maxItems)) {
    if (overBudget(ctx.counts, ctx.input.deadlineAt)) {
      ctx.counts.truncated = true;
      return;
    }
    const payload = await ctx.action.call({
      ...literals,
      [batchPath.param]: group,
    });
    ctx.counts.upstreamCalls += 1;
    for (const row of extractRows(payload, ctx.source.resultPath) ?? []) {
      const answered = scalarKey(readPath(row, batchPath.answerPath));
      if (answered === undefined) continue;
      for (const recordId of byValue.get(answered) ?? []) {
        ctx.answers.set(recordId, row);
      }
    }
  }
};

const callOneByOne = async (ctx: {
  action: SyncReadAction;
  resultPath: string | null;
  askable: { candidate: Candidate; args: Record<string, unknown> }[];
  answers: Map<string, unknown>;
  counts: SyncRunCounts;
  input: { connection: ExternalAppConnection; deadlineAt: number };
  state: RecordSyncStateWrite[];
}): Promise<void> => {
  // A serial connection holds ONE slot (`withConnectionSlot`, taken inside the
  // executor), so firing four at it would only queue three on the Redis lock
  // and time them out at `maxWaitMs`. Asking the declaration first turns that
  // contention into a queue nobody has to wait out — the same reasoning
  // `run-page-data` uses for a page's datasets.
  const width = isSerialConnection(ctx.input.connection) ? 1 : PARALLEL_CALLS;
  const queue = [...ctx.askable];

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      if (overBudget(ctx.counts, ctx.input.deadlineAt)) {
        ctx.counts.truncated = true;
        return;
      }
      ctx.counts.upstreamCalls += 1;
      try {
        const payload = await ctx.action.call(next.args);
        const rows = extractRows(payload, ctx.resultPath) ?? [];
        const row = rows[0];
        if (row !== undefined) ctx.answers.set(next.candidate.recordId, row);
      } catch (error) {
        // One record's failure is one record's failure. A 404 for a company
        // that does not exist upstream is the normal case, not a broken run.
        ctx.counts.failedCount += 1;
        ctx.state.push({
          recordId: next.candidate.recordId,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          failed: true,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
};

/**
 * The string form of a value used as a batch key, or `undefined` when it has
 * none.
 *
 * Refusing an object here rather than stringifying it is the whole safety of
 * batching: `String({})` is `"[object Object]"`, so every record whose key was
 * a nested value would collapse onto ONE bucket and each would be handed
 * another's answer. A key that is not a scalar is a mapping mistake, and the
 * record is simply left out of the batch.
 */
const scalarKey = (value: unknown): string | undefined => {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
};

const overBudget = (counts: SyncRunCounts, deadlineAt: number): boolean =>
  counts.upstreamCalls >= SYNC_LIMITS.maxUpstreamCallsPerRun ||
  Date.now() >= deadlineAt;
