import { sql } from "drizzle-orm";
import db from "../../db";
import type {
  CollectionSyncRunStatus,
  CollectionSyncRunTrigger,
  CollectionSyncSource,
} from "../../db/schema";
import { collectionSyncRuns } from "../../db/schema";
import {
  SYNC_LIMITS,
  syncArgsBindSince,
  type SyncRunCounts,
  type SyncStopReason,
  type TableWalkCheckpoint,
} from "../../schemas/collection-sync";
import { canonicalHash } from "../approvals/hash";
import { enqueueContinuation } from "./queue";
import { resolveSyncAction } from "./resolve-action";
import { runLookupSync } from "./run-lookup-sync";
import { emptyCounts, runTableSync } from "./run-table-sync";
import { claimSyncSource, scheduleNextRun } from "./sweep";

/**
 * One run, start to finish — the only thing the worker calls.
 *
 * It owns the lifecycle and nothing else: claim the source so two replicas
 * cannot run it at once, open (or REJOIN) a `collection_sync_runs` row, hand the
 * work to the `table` or `lookup` runner, and close both the run and the
 * source's schedule whatever happened. The two runners never touch either.
 *
 * LEGS. A `table` walk that runs out of budget does not truncate any more: it
 * stores its position on the source and enqueues a continuation, which rejoins
 * the SAME run row. One walk is therefore one entry in the history with
 * `legs: 7`, not seven runs nobody can tell apart — and, more importantly, a
 * first load of 300 000 rows finishes instead of stopping at whatever fits in
 * ten minutes, for ever.
 *
 * A failure is a VALUE here, never a thrown exception escaping to BullMQ. The
 * run row is the history a person reads, the source's `lastError` is what the
 * banner shows, and `consecutiveFailures` is what eventually pauses a source
 * whose app has been refusing for a day. A job that threw would leave all three
 * unwritten and the source claimed until the claim expired.
 */

export type SyncRunOutcomeStatus = CollectionSyncRunStatus | "skipped";

export interface RunSyncSourceResult {
  status: SyncRunOutcomeStatus;
  runId?: string;
  counts?: SyncRunCounts;
  error?: string;
  /** Present when nothing ran, so the worker's log says why. */
  skippedReason?: "not_found" | "disabled" | "already_running";
  /** The walk suspended and a continuation is queued. */
  suspended?: boolean;
  /** Which bound bit, when one did. */
  stopReason?: SyncStopReason;
  legs?: number;
}

/**
 * Everything whose change invalidates a stored position.
 *
 * A checkpoint is an OFFSET INTO A LIST, and every field below decides which
 * list. Resuming a walk after the arguments changed would page through a
 * different answer from row 40 000 as though the first 40 000 had been seen.
 */
const configHashOf = (source: CollectionSyncSource): string =>
  canonicalHash({
    operation: source.operation,
    connectionId: source.connectionId,
    args: source.args,
    resultPath: source.resultPath,
    externalIdPath: source.externalIdPath,
    fieldMapping: source.fieldMapping,
  });

/**
 * Should this walk ask for EVERYTHING, rather than what changed?
 *
 * Yes when the source does not read incrementally at all (then every walk is a
 * full one), when it never has, or when the last full walk is older than
 * `fullWalkIntervalMinutes`. That periodic full pass is not an optimisation: it
 * is the ONLY moment a deletion upstream can be noticed, because an incremental
 * answer never mentions the rows that did not change.
 *
 * The answer decides whether the orphan diff runs at all, so getting it wrong
 * is silent in both directions: say "incremental" of a complete answer and
 * deletions go unseen; say "full" of a partial one and the untouched
 * collection is declared gone.
 */
export const shouldWalkEverything = (
  source: Pick<
    CollectionSyncSource,
    "args" | "lastSuccessAt" | "lastFullWalkAt"
  >,
  now: Date = new Date(),
): boolean => {
  // Nothing binds `{"$since": true}` ⇒ the app is asked the same unbounded
  // question every time, so every answer is the whole truth and every walk is a
  // full one. Without this the periodic pass was the only one that diffed, and
  // a source that CANNOT read incrementally — which is every source the form
  // produces unless somebody binds the parameter — spent 24 hours treating
  // complete answers as partial ones. An upstream returning nothing was then
  // recorded as a clean `success` with zero orphans: the exact reading the
  // floor exists to refuse.
  if (!syncArgsBindSince(source.args)) return true;
  if (source.lastSuccessAt === null) return true;
  if (source.lastFullWalkAt === null) return true;
  const age = now.getTime() - source.lastFullWalkAt.getTime();
  return age >= SYNC_LIMITS.fullWalkIntervalMinutes * 60_000;
};

export const runSyncSource = async (input: {
  sourceId: string;
  trigger: CollectionSyncRunTrigger;
  recordIds?: string[];
  triggeredByUserId?: string | null;
  /** The sweep already holds the claim — see `ExternalSyncJobData`. */
  preClaimed?: boolean;
  /** This job continues a suspended walk. */
  continueFrom?: { runId: string };
}): Promise<RunSyncSourceResult> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: input.sourceId },
  });
  if (source === undefined) {
    return { status: "skipped", skippedReason: "not_found" };
  }
  if (!source.enabled) {
    return { status: "skipped", skippedReason: "disabled" };
  }
  if (input.preClaimed !== true && !(await claimSyncSource(source.id))) {
    // A run is already under way. THIS is what makes "Refresh" idempotent
    // however many times it is pressed, and what keeps a scheduled tick from
    // doubling a manual refresh.
    return { status: "skipped", skippedReason: "already_running" };
  }

  const configHash = configHashOf(source);
  const resume = resumableCheckpoint(source, configHash, input.continueFrom);
  // A checkpoint that cannot be resumed is dropped rather than honoured: it
  // points into a list that no longer exists, and a stale position is worse
  // than starting over because it silently skips rows.
  if (source.walkCheckpoint !== null && resume === null) {
    await clearCheckpoint(source.id);
  }

  // `startedAt` MUST come from the database, never from `new Date()`. It is
  // the boundary the orphan bracket compares `record_sync_state.synced_at`
  // against, and both sides therefore have to be the same clock: a worker whose
  // wall clock runs a few seconds ahead of Postgres would see every row it just
  // stamped as "not seen by this walk" and orphan the whole collection. That is
  // not hypothetical — it reproduced on the first integration run, against a
  // containerised Postgres a moment behind the host.
  const run = resume
    ? { id: resume.runId, startedAt: new Date(resume.walkStartedAt) }
    : await openRun(source, input);
  if (run === undefined) {
    throw new Error(
      "could not open a run row for this sync source — refusing to walk without one, since the run's own start is what decides which records this walk did not see",
    );
  }
  const runId = run.id;

  const startedAt = Date.now();
  let counts: SyncRunCounts = resume ? { ...resume.counts } : emptyCounts();
  let status: CollectionSyncRunStatus = "success";
  let error: string | undefined;
  let stopReason: SyncStopReason | undefined;
  let suspension: { checkpoint: TableWalkCheckpoint; delayMs: number } | null =
    null;
  let floorReason: string | undefined;
  let retryAfterMs: number | undefined;
  let fullWalk = false;

  try {
    const connection =
      source.connectionId === null
        ? undefined
        : await db.query.externalAppConnections.findFirst({
            where: { id: source.connectionId, teamId: source.teamId },
          });
    if (connection === undefined) {
      throw new Error(
        "the connection this source reads through is gone — reconnect the app and the data is picked up again; nothing stored has been lost",
      );
    }
    // The deadline is settled BEFORE the action is resolved, because the
    // resolved `call` closes over it: every upstream call this run makes waits
    // for its permit in `background` mode, against this run's own budget. Left
    // interactive — which it was — a run gave up on a busy connection after
    // eight seconds and reported `rate_limited`, discarding minutes it had in
    // hand and a position it could have kept walking from.
    const deadlineAt = startedAt + SYNC_LIMITS.runBudgetMs;

    const resolved = await resolveSyncAction(connection, source.operation, {
      governor: { kind: "background", deadlineAt },
    });
    if (!resolved.ok) throw new Error(resolved.message);

    if (source.kind === "lookup") {
      const outcome = await runLookupSync({
        source,
        connection,
        action: resolved.action,
        deadlineAt,
        ...(input.recordIds !== undefined
          ? { recordIds: input.recordIds }
          : {}),
      });
      counts = outcome.counts;
      if (outcome.retryAfterMs !== undefined) {
        // No position to resume from — the work list is rebuilt from
        // `record_sync_state` every run — so the wait is applied to the
        // SCHEDULE instead of to a continuation.
        stopReason = "rate_limited";
        retryAfterMs = outcome.retryAfterMs;
      }
      status =
        counts.failedCount > 0 || counts.truncated ? "partial" : "success";
    } else {
      // A confirmed full resync forces BOTH: everything is walked, and the
      // floor that refused last time is stood down for this one walk only.
      const confirmed = source.fullResyncConfirmedAt !== null;
      fullWalk =
        resume?.fullWalk ?? (confirmed || shouldWalkEverything(source));
      const outcome = await runTableSync({
        source,
        action: resolved.action,
        deadlineAt,
        runId,
        walkStartedAt: run.startedAt,
        configHash,
        resume,
        fullWalk,
        ignoreOrphanFloor: resume?.ignoreOrphanFloor ?? confirmed,
      });
      counts = outcome.counts;
      if (outcome.kind === "suspended") {
        // The walk is NOT over, so the run row stays `running` and nothing is
        // stamped. What ends here is this job.
        status = "running";
        stopReason = outcome.reason;
        suspension = {
          checkpoint: outcome.checkpoint,
          delayMs:
            outcome.reason === "rate_limited" ? (outcome.retryAfterMs ?? 0) : 0,
        };
      } else if (outcome.kind === "floor") {
        status = "partial";
        stopReason = "orphan_floor";
        floorReason = outcome.reason;
      } else {
        // `partial` is the honest word for both shapes of incomplete: rows that
        // failed, and a walk that stopped at a bound nothing can resume.
        status =
          counts.failedCount > 0 || counts.truncated ? "partial" : "success";
      }
    }
  } catch (cause) {
    status = "failed";
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const legs = suspension?.checkpoint.legs ?? resume?.legs ?? 1;
  await db.execute(sql`
      UPDATE collection_sync_runs
         SET status = ${status}::collection_sync_run_status,
             finished_at = ${status === "running" ? sql`NULL` : sql`now()`},
             created_count = ${counts.createdCount},
             updated_count = ${counts.updatedCount},
             unchanged_count = ${counts.unchangedCount},
             orphan_count = ${counts.orphanCount},
             failed_count = ${counts.failedCount},
             missing_count = ${counts.missingCount},
             upstream_calls = ${counts.upstreamCalls},
             truncated = ${counts.truncated},
             legs = ${legs},
             stop_reason = ${stopReason ?? null},
             error = ${error ?? floorReason ?? null}
       WHERE id = ${runId}::uuid`);

  if (suspension !== null) {
    await suspend(source, suspension.checkpoint);
    await enqueueContinuation({
      sourceId: source.id,
      teamId: source.teamId,
      trigger: input.trigger,
      runId: suspension.checkpoint.runId,
      delayMs: suspension.delayMs,
    });
    return {
      status: "running",
      runId,
      counts,
      suspended: true,
      ...(stopReason !== undefined ? { stopReason } : {}),
      legs,
    };
  }

  // `lastSuccessAt` moves ONLY on a clean run, and that is a correctness rule
  // rather than bookkeeping: it is the lower bound an incremental read binds
  // (`{"$since": true}`), so stamping it after a truncated pass would make the
  // next run ask for "everything since now" and silently skip every row the
  // bound cut off.
  await scheduleNextRun(source, {
    ok: status !== "failed",
    ...(error !== undefined ? { error } : {}),
    ...(status === "success" ? { succeededAt: new Date() } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  await closeWalk(source.id, {
    // A run that never reached the third party reached no verdict about the
    // data either, so it leaves the full-resync ask exactly as it found it.
    // Clearing it on a transient 500 would take the offer off the screen and
    // make the person wait for the floor to trip a second time.
    reachedVerdict: status !== "failed",
    ...(status === "success" && fullWalk ? { fullWalkAt: new Date() } : {}),
    ...(floorReason !== undefined ? { floorReason } : {}),
  });

  await trimRunHistory(source.id);

  return {
    status,
    runId,
    counts,
    ...(error !== undefined ? { error } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    legs,
  };
};

/**
 * The stored checkpoint, if this job may resume it.
 *
 * Three ways to say no, and each one is a different kind of staleness: the
 * arguments changed under it, the walk has taken more legs than
 * `maxRunLegs` allows, or this job belongs to a different run (a scheduled tick
 * landing on a suspended walk — it must not rejoin one it was not handed).
 */
const resumableCheckpoint = (
  source: CollectionSyncSource,
  configHash: string,
  continueFrom: { runId: string } | undefined,
): TableWalkCheckpoint | null => {
  const checkpoint = source.walkCheckpoint;
  if (checkpoint === null || checkpoint.version !== 1) return null;
  if (checkpoint.configHash !== configHash) return null;
  if (checkpoint.legs > SYNC_LIMITS.maxRunLegs) return null;
  if (continueFrom !== undefined && continueFrom.runId !== checkpoint.runId) {
    return null;
  }
  return checkpoint;
};

const openRun = async (
  source: CollectionSyncSource,
  input: {
    trigger: CollectionSyncRunTrigger;
    triggeredByUserId?: string | null;
  },
): Promise<{ id: string; startedAt: Date } | undefined> => {
  const [run] = await db
    .insert(collectionSyncRuns)
    .values({
      syncSourceId: source.id,
      teamId: source.teamId,
      status: "running",
      trigger: input.trigger,
      triggeredByUserId: input.triggeredByUserId ?? null,
    })
    .returning({
      id: collectionSyncRuns.id,
      startedAt: collectionSyncRuns.startedAt,
    });
  return run;
};

/**
 * Freeze the walk on the source row and RENEW the lease.
 *
 * Renewing rather than releasing is the whole trick: the source stays claimed
 * across the gap between two legs, so the minute-ly sweep cannot pick it up and
 * start a second walk over the same list — while a runner that dies between
 * legs still loses the claim after `SYNC_CLAIM_TIMEOUT_MS` and is recovered.
 * `next_run_at` is deliberately untouched: the schedule resumes from the moment
 * the walk actually finishes.
 */
const suspend = async (
  source: CollectionSyncSource,
  checkpoint: TableWalkCheckpoint,
): Promise<void> => {
  await db.execute(sql`
    UPDATE collection_sync_sources
       SET walk_checkpoint = ${JSON.stringify(checkpoint)}::jsonb,
           claimed_at = now(),
           last_run_at = now()
     WHERE id = ${source.id}::uuid`);
};

const clearCheckpoint = async (sourceId: string): Promise<void> => {
  await db.execute(sql`
    UPDATE collection_sync_sources
       SET walk_checkpoint = NULL
     WHERE id = ${sourceId}::uuid`);
};

/**
 * The walk is over, one way or another: drop the checkpoint, stamp the full
 * walk if that is what it was, and either raise or clear the full-resync ask.
 *
 * Clearing on ANY finished walk that did not hit the floor is deliberate. The
 * ask is about one specific diff; once a later walk has come back with a
 * believable answer, the question it posed no longer has a subject, and leaving
 * the banner up would have a person confirming a resync against numbers that
 * are no longer true.
 */
const closeWalk = async (
  sourceId: string,
  outcome: { reachedVerdict: boolean; fullWalkAt?: Date; floorReason?: string },
): Promise<void> => {
  const floor = outcome.floorReason;
  const resync = !outcome.reachedVerdict
    ? sql``
    : sql`full_resync_requested_at = ${floor === undefined ? sql`NULL` : sql`now()`},
          full_resync_reason = ${floor ?? null},
          full_resync_confirmed_at = NULL,`;
  await db.execute(sql`
    UPDATE collection_sync_sources
       SET ${outcome.fullWalkAt === undefined ? sql`` : sql`last_full_walk_at = ${outcome.fullWalkAt},`}
           ${resync}
           walk_checkpoint = NULL
     WHERE id = ${sourceId}::uuid`);
};

/**
 * Keep the latest runs and drop the rest — the retention `page_versions` and
 * `ai_memory_history` already use. Post-insert rather than on a sweep because
 * the only moment a source's history can grow is the moment it just did.
 */
const trimRunHistory = async (syncSourceId: string): Promise<void> => {
  await db.execute(sql`
    DELETE FROM collection_sync_runs
     WHERE sync_source_id = ${syncSourceId}::uuid
       AND id NOT IN (
         SELECT id FROM collection_sync_runs
          WHERE sync_source_id = ${syncSourceId}::uuid
          ORDER BY started_at DESC
          LIMIT ${SYNC_LIMITS.runHistoryLimit}
       )`);
};
