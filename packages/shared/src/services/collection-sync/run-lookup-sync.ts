import type {
  CollectionSyncSource,
  ExternalAppConnection,
} from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import {
  isSyncFieldBinding,
  SYNC_LIMITS,
  type SyncRunCounts,
} from "../../schemas/collection-sync";
import { bulkUpdateCollectionRecords } from "../collection-records/bulk-update";
import { readRecordDataBatch } from "../collection-schema/record-io";
import { isSingleFlightConnection } from "../external-apps/exec/governor/policy";
import { UpstreamRateLimitedError } from "../external-apps/exec/governor/upstream-error";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { syncActor } from "./agent-key";
import {
  type LookupCandidate,
  selectLookupCandidates,
} from "./lookup-candidates";
import { projectRow, readPath } from "./project-row";
import {
  type RecordSyncStateWrite,
  upsertRecordSyncState,
} from "./record-state";
import type { SyncReadAction } from "./resolve-action";
import { resolveSyncArgs } from "./resolve-args";
import { emptyCounts, ownedFields } from "./run-table-sync";
import { extractRows } from "./walk-read";

/**
 * One run of a `lookup` source: some COLUMNS of records the source does not
 * own, filled per record from its own key.
 *
 * This is the N+1 the plan calls the real difficulty (§0.5), and the four
 * answers to it are all here:
 *
 *  1. A BOUNDED WORK LIST, picked by five indexed queries rather than a sort of
 *     the collection — see `lookup-candidates.ts`.
 *  2. `batch` WHEN THE API HAS IT. One call for twenty records instead of
 *     twenty calls, which is the only structural fix — everything else is
 *     rationing. And when the API HAS it, the run takes a work list sized to
 *     what batching can actually get through, not the one-by-one 200: an action
 *     that batches 200 at a time can finish 20 000 records in a hundred calls,
 *     and rationing it to 200 would take two and a half days to make one pass
 *     over a 50 000-row collection.
 *  3. NO CALL AT ALL when the answer is already known. A record with no value
 *     for the bound key cannot be looked up, so it is marked `missing` and
 *     skipped without spending anything; and a record whose answer hashes to
 *     what is already stored costs no UPDATE, no journal entry and no
 *     re-embedding.
 *  4. AN EMPTY ANSWER IS AN ANSWER. A call that came back with no row writes
 *     `missing` — and that is a fix, not a nicety. Without it, a record the app
 *     has never heard of was asked about on EVERY run, for ever: a source at
 *     fifteen minutes with 200 such records spent 19 200 calls a day learning
 *     the same nothing, and reported `success` with zero counts while doing it.
 */

/**
 * Records whose data is read, called for and written in one pass.
 *
 * The work list may be 20 000 long; their `data` maps must never all be in
 * memory at once, so the run walks them in groups and each group's rows are
 * released before the next is read.
 */
const LOOKUP_GROUP = 1_000;

/** Concurrent calls on a connection the provider does not declare `serial`. */
const PARALLEL_CALLS = 4;

/** What the batch declaration, if any, means for this source. */
interface BatchBinding {
  param: string;
  maxItems: number;
  answerPath: string;
}

export interface LookupRunResult {
  counts: SyncRunCounts;
  /**
   * The third party asked us to wait. A `lookup` run has no position to
   * resume from — its work list is rebuilt from `record_sync_state` every time
   * — so instead of suspending it pushes its NEXT run out by this much. Without
   * that the source would come back on its ordinary cadence, be refused by the
   * governor before a single call went out, and record a failed run for
   * nothing.
   */
  retryAfterMs?: number;
}

export const runLookupSync = async (input: {
  source: CollectionSyncSource;
  connection: ExternalAppConnection;
  action: SyncReadAction;
  deadlineAt: number;
  /** Records the caller named — refreshed before anything else. */
  recordIds?: string[];
}): Promise<LookupRunResult> => {
  const { source, action } = input;
  const counts = emptyCounts();

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: source.teamId,
    collectionId: source.collectionId,
  });
  const fields = ownedFields(source, fieldDefs);
  if (fields.length === 0) return { counts };

  const batchPath = batchBinding(source, action);
  const candidates = await selectLookupCandidates({
    source,
    limit: candidateLimit(batchPath),
    ...(input.recordIds !== undefined ? { requested: input.recordIds } : {}),
  });
  if (candidates.length === 0) return { counts };

  for (const group of chunkForBulk(candidates, LOOKUP_GROUP)) {
    if (overBudget(counts, input.deadlineAt)) {
      counts.truncated = true;
      break;
    }
    const stopped = await refreshGroup({
      source,
      action,
      connection: input.connection,
      deadlineAt: input.deadlineAt,
      fieldDefs,
      fields,
      group,
      counts,
      ...(batchPath !== undefined ? { batchPath } : {}),
    });
    if (stopped !== undefined) {
      counts.truncated = true;
      return { counts, retryAfterMs: stopped };
    }
  }

  return { counts };
};

/**
 * How many records one run may take.
 *
 * Without batching it is the old 200: each is a call, and the call budget is
 * what really bounds the run. With batching the ceiling is what the budget
 * could get through — calls × items per call — capped so a run stays a run.
 */
const candidateLimit = (batch: BatchBinding | undefined): number =>
  batch === undefined
    ? SYNC_LIMITS.lookupBatchSize
    : Math.min(
        SYNC_LIMITS.maxUpstreamCallsPerRun * batch.maxItems,
        SYNC_LIMITS.lookupMaxRecordsPerRun,
      );

/**
 * One group: read its data, ask, write. A number back is the wait the third
 * party asked for, and means "stop the run".
 */
const refreshGroup = async (ctx: {
  source: CollectionSyncSource;
  action: SyncReadAction;
  connection: ExternalAppConnection;
  deadlineAt: number;
  fieldDefs: Awaited<ReturnType<typeof getFieldDefinitionsForTeam>>;
  fields: ReturnType<typeof ownedFields>;
  group: LookupCandidate[];
  counts: SyncRunCounts;
  batchPath?: BatchBinding;
}): Promise<number | undefined> => {
  const { source, counts } = ctx;
  const data = await readRecordDataBatch({
    collectionId: source.collectionId,
    recordIds: ctx.group.map((candidate) => candidate.recordId),
    fields: ctx.fieldDefs,
  });

  const state: RecordSyncStateWrite[] = [];
  const askable: {
    candidate: LookupCandidate;
    args: Record<string, unknown>;
  }[] = [];
  for (const candidate of ctx.group) {
    const { args, missingFieldKeys } = resolveSyncArgs({
      args: source.args,
      since: null,
      ...(ctx.action.incremental !== undefined
        ? { incremental: ctx.action.incremental }
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
      counts.missingCount += 1;
      continue;
    }
    askable.push({ candidate, args });
  }

  const answers = new Map<string, unknown>();
  let rateLimited: number | undefined;
  if (ctx.batchPath !== undefined) {
    rateLimited = await callBatched({
      source,
      action: ctx.action,
      askable,
      answers,
      counts,
      deadlineAt: ctx.deadlineAt,
      batchPath: ctx.batchPath,
      state,
    });
  } else {
    rateLimited = await callOneByOne({
      action: ctx.action,
      resultPath: source.resultPath,
      connection: ctx.connection,
      askable,
      answers,
      counts,
      deadlineAt: ctx.deadlineAt,
      state,
    });
  }

  const updates: {
    recordId: string;
    data: Record<string, unknown>;
    hash: string;
  }[] = [];
  const answered = new Set<string>();
  for (const { candidate } of askable) {
    if (!answers.has(candidate.recordId)) continue;
    answered.add(candidate.recordId);
    const row = answers.get(candidate.recordId);
    const projection = projectRow({
      row,
      mapping: source.fieldMapping,
      fields: ctx.fields,
    });
    if (projection.hash === candidate.contentHash) {
      counts.unchangedCount += 1;
      continue;
    }
    updates.push({ recordId: candidate.recordId, ...projection });
  }

  for (const batch of chunkForBulk(updates)) {
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
    if (!answered.has(candidate.recordId)) continue;
    if (written.has(candidate.recordId)) continue;
    state.push({
      recordId: candidate.recordId,
      status: "ok",
      contentHash: candidate.contentHash,
    });
  }

  await upsertRecordSyncState(source.id, state);
  return rateLimited;
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
): BatchBinding | undefined => {
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

/** `true` when the third party told us to stop. */
const callBatched = async (ctx: {
  source: CollectionSyncSource;
  action: SyncReadAction;
  askable: { candidate: LookupCandidate; args: Record<string, unknown> }[];
  answers: Map<string, unknown>;
  counts: SyncRunCounts;
  deadlineAt: number;
  batchPath: BatchBinding;
  state: RecordSyncStateWrite[];
}): Promise<number | undefined> => {
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

  const asked = new Set<string>();
  for (const group of chunkForBulk([...byValue.keys()], batchPath.maxItems)) {
    if (overBudget(ctx.counts, ctx.deadlineAt)) {
      ctx.counts.truncated = true;
      return undefined;
    }
    let payload: unknown;
    try {
      payload = await ctx.action.call({
        ...literals,
        [batchPath.param]: group,
      });
    } catch (cause) {
      if (cause instanceof UpstreamRateLimitedError) return cause.retryAfterMs;
      throw cause;
    }
    ctx.counts.upstreamCalls += 1;
    for (const key of group) asked.add(key);
    for (const row of extractRows(payload, ctx.source.resultPath) ?? []) {
      const answered = scalarKey(readPath(row, batchPath.answerPath));
      if (answered === undefined) continue;
      for (const recordId of byValue.get(answered) ?? []) {
        ctx.answers.set(recordId, row);
      }
    }
  }

  // Asked for and not in the answer: the app does not have this row. Recorded
  // as such so it rests for `lookupMissingRetryMs` instead of being asked
  // again on the next run, and on every run after that. Only keys that were
  // ACTUALLY sent — a group the budget cut off was never asked, and marking
  // those `missing` would be recording an answer nobody gave.
  for (const [key, recordIds] of byValue) {
    if (!asked.has(key)) continue;
    for (const recordId of recordIds) {
      if (ctx.answers.has(recordId)) continue;
      ctx.counts.missingCount += 1;
      ctx.state.push({
        recordId,
        status: "missing",
        error: `the app did not return a row for "${key}"`,
      });
    }
  }
  return undefined;
};

/** The wait the third party asked for, when it told us to stop. */
const callOneByOne = async (ctx: {
  action: SyncReadAction;
  resultPath: string | null;
  connection: ExternalAppConnection;
  askable: { candidate: LookupCandidate; args: Record<string, unknown> }[];
  answers: Map<string, unknown>;
  counts: SyncRunCounts;
  deadlineAt: number;
  state: RecordSyncStateWrite[];
}): Promise<number | undefined> => {
  // A single-flight connection holds ONE seat (the permit, taken inside the
  // executor), so firing four at it would only queue three on the governor and
  // time them out at the policy's wait budget. Asking the policy first turns
  // that contention into a queue nobody has to wait out — the same reasoning
  // `run-page-data` uses for a page's datasets.
  const width = isSingleFlightConnection(ctx.connection) ? 1 : PARALLEL_CALLS;
  const queue = [...ctx.askable];
  let rateLimited: number | undefined;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (rateLimited !== undefined) return;
      const next = queue.shift();
      if (next === undefined) return;
      if (overBudget(ctx.counts, ctx.deadlineAt)) {
        ctx.counts.truncated = true;
        return;
      }
      ctx.counts.upstreamCalls += 1;
      try {
        const payload = await ctx.action.call(next.args);
        const rows = extractRows(payload, ctx.resultPath) ?? [];
        const row = rows[0];
        if (row !== undefined) {
          ctx.answers.set(next.candidate.recordId, row);
          continue;
        }
        // The call succeeded and there was nothing there. See the class
        // comment: writing this down is what stops the same empty question
        // being asked four times an hour for ever.
        ctx.counts.missingCount += 1;
        ctx.state.push({
          recordId: next.candidate.recordId,
          status: "missing",
          error: "the app has no row for this record's key",
        });
      } catch (error) {
        // A refusal is not this record's fault and not this record's problem:
        // it ends the RUN, because every other record in the queue is about to
        // be refused too and spending the budget discovering that helps nobody.
        if (error instanceof UpstreamRateLimitedError) {
          rateLimited = error.retryAfterMs;
          return;
        }
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
  return rateLimited;
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
