import {
  COLLECTION_INDEX_SWEEP_JOB,
  CONVERSATION_TASK_SWEEP_JOB,
  DREAMING_SWEEP_JOB,
  GC_DEMOTE_JOB,
  JOURNAL_SWEEP_JOB,
  MCP_SNAPSHOT_REFRESH_JOB,
  MODEL_ALERT_SWEEP_JOB,
  MODEL_SYNC_JOB,
  MODEL_TELEMETRY_ROLLUP_JOB,
  VECTOR_RECONCILE_SWEEP_JOB,
  WORKFLOW_STALL_SWEEP_JOB,
  WORKFLOW_TRIGGER_SWEEP_JOB,
} from "./names";
import {
  getCollectionIndexQueue,
  getMcpRefreshQueue,
  getMemoryMaintenanceQueue,
  getModelSyncQueue,
  getVectorReconcileQueue,
} from "./queues";

/**
 * Repeatable-job registration. BullMQ job schedulers are queue-level state
 * keyed by scheduler id — every replica upserts the same ids, so N replicas
 * still produce ONE job per interval.
 *
 * Most land on the maintenance queue, which runs at concurrency 1: the journal
 * + workflow-trigger sweeps are cheap (reads + enqueue), the nightly triggers
 * fan work out elsewhere, and the stall sweep is one bounded UPDATE. A job that
 * can occupy that worker for MINUTES gets its own queue instead — see the MCP
 * refresh and the collection-index sweep at the bottom.
 */

const SWEEP_INTERVAL_MS = 15_000;
/** Reclaim stalled workflow runs every 5 min (backs the orchestrator's own
 * onFailure finalize; heartbeat-gap is 20 min, so 5 min is timely enough). */
const STALL_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Dreaming at 03:00 UTC, GC an hour later — both in the quiet window. */
const DREAMING_CRON = "0 3 * * *";
const GC_CRON = "0 4 * * *";
/** MCP tool-snapshot drift refresh at 05:00 UTC — after the memory window. */
const MCP_REFRESH_CRON = "0 5 * * *";
/** Object-index sweep at 02:00 UTC, ahead of the memory window: it issues
 * `CREATE INDEX CONCURRENTLY`, which is IO-heavy and best kept away from the
 * dreaming and GC passes. */
const COLLECTION_INDEX_CRON = "0 2 * * *";
/** 01:00 UTC — after the model sync at 00:30, before the index sweep at 02:00. */
const VECTOR_RECONCILE_CRON = "0 1 * * *";
/**
 * 00:30 UTC — opens the nightly chain, half an hour AHEAD of vector-reconcile.
 * Both passes are network-bound (upstream catalogues here, the AI service
 * there) and neither has a duration we control, so overlapping them would put
 * two long crawls on the same egress and the same connection pool on the one
 * night nobody is watching. The gap is a separation, not a guarantee: a sync
 * that overruns 01:00 simply runs alongside, on its own queue.
 */
const MODEL_SYNC_CRON = "30 0 * * *";
/** 5min — collapses whatever the engine decided since the last pass into one
 * email. See MODEL_ALERT_SWEEP_JOB for why delivery is not done at the raise
 * site. */
const MODEL_ALERT_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Ten past the hour — the bucket that just closed is the one being folded, and
 * a few minutes of slack keeps a call that started at 59:59 from landing in
 * Redis after its own bucket has been drained and deleted.
 */
const MODEL_TELEMETRY_ROLLUP_CRON = "10 * * * *";

const CRON_OPTS = {
  removeOnComplete: { count: 30 },
  removeOnFail: { count: 100 },
};

/**
 * Retries cover a REJECTION only. Everything `runModelSync` can attribute — a
 * catalogue that will not answer, one model that blows up — it reports as a
 * status plus `stats.errors` and returns normally, which BullMQ correctly reads
 * as a completed job. What is left is the unexpected throw, and replaying the
 * pass is safe for it: every row is recomputed from the upstream catalogues
 * rather than incremented, so a second attempt rewrites the same values.
 *
 * Two attempts, not more. Beyond that the failure is ours or the upstream is
 * down for the night, and the `model_sync_runs` row is where that gets read.
 */
const MODEL_SYNC_OPTS = {
  ...CRON_OPTS,
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 60_000 },
};

export const registerSchedulers = async (): Promise<void> => {
  const maintenance = getMemoryMaintenanceQueue();
  await maintenance.upsertJobScheduler(
    JOURNAL_SWEEP_JOB,
    { every: SWEEP_INTERVAL_MS },
    {
      name: JOURNAL_SWEEP_JOB,
      opts: {
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 100 },
      },
    },
  );
  await maintenance.upsertJobScheduler(
    DREAMING_SWEEP_JOB,
    { pattern: DREAMING_CRON, tz: "UTC" },
    { name: DREAMING_SWEEP_JOB, opts: CRON_OPTS },
  );
  await maintenance.upsertJobScheduler(
    GC_DEMOTE_JOB,
    { pattern: GC_CRON, tz: "UTC" },
    { name: GC_DEMOTE_JOB, opts: CRON_OPTS },
  );
  await maintenance.upsertJobScheduler(
    WORKFLOW_TRIGGER_SWEEP_JOB,
    { every: SWEEP_INTERVAL_MS },
    {
      name: WORKFLOW_TRIGGER_SWEEP_JOB,
      opts: {
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 100 },
      },
    },
  );
  await maintenance.upsertJobScheduler(
    WORKFLOW_STALL_SWEEP_JOB,
    { every: STALL_SWEEP_INTERVAL_MS },
    { name: WORKFLOW_STALL_SWEEP_JOB, opts: CRON_OPTS },
  );
  await maintenance.upsertJobScheduler(
    CONVERSATION_TASK_SWEEP_JOB,
    { every: STALL_SWEEP_INTERVAL_MS },
    { name: CONVERSATION_TASK_SWEEP_JOB, opts: CRON_OPTS },
  );
  // Stays on the maintenance queue: one indexed read that is empty on almost
  // every pass, and at most one email. Nothing here can hold the worker.
  await maintenance.upsertJobScheduler(
    MODEL_ALERT_SWEEP_JOB,
    { every: MODEL_ALERT_SWEEP_INTERVAL_MS },
    { name: MODEL_ALERT_SWEEP_JOB, opts: CRON_OPTS },
  );
  // Also on the maintenance queue: a `SCAN` of a small keyspace and one insert
  // per closed bucket, no network call. Hourly rather than nightly because the
  // Redis counters it drains expire after 48 h — a missed hour is recoverable,
  // a missed day is measurements gone for good.
  await maintenance.upsertJobScheduler(
    MODEL_TELEMETRY_ROLLUP_JOB,
    { pattern: MODEL_TELEMETRY_ROLLUP_CRON, tz: "UTC" },
    { name: MODEL_TELEMETRY_ROLLUP_JOB, opts: CRON_OPTS },
  );
  // Dedicated queue — one pass can hold a `CREATE INDEX CONCURRENTLY` for
  // minutes, which on the concurrency-1 maintenance queue would stop the 15s
  // sweeps outright for the duration.
  await getCollectionIndexQueue().upsertJobScheduler(
    COLLECTION_INDEX_SWEEP_JOB,
    { pattern: COLLECTION_INDEX_CRON, tz: "UTC" },
    { name: COLLECTION_INDEX_SWEEP_JOB, opts: CRON_OPTS },
  );

  // Dedicated queue — the refresh re-introspects every MCP connection over the
  // network, so it lands here, not on the 15s maintenance queue.
  await getMcpRefreshQueue().upsertJobScheduler(
    MCP_SNAPSHOT_REFRESH_JOB,
    { pattern: MCP_REFRESH_CRON, tz: "UTC" },
    { name: MCP_SNAPSHOT_REFRESH_JOB, opts: CRON_OPTS },
  );

  // Opens the nightly chain, on its own queue: nothing else may be running
  // when the fleet's routing table is rewritten, and a crawl of four public
  // APIs must not sit in front of a 15s sweep. `attempts: 2` is the whole
  // retry policy — see MODEL_SYNC_OPTS.
  await getModelSyncQueue().upsertJobScheduler(
    MODEL_SYNC_JOB,
    { pattern: MODEL_SYNC_CRON, tz: "UTC" },
    { name: MODEL_SYNC_JOB, opts: MODEL_SYNC_OPTS },
  );

  // Second of the nightly chain, and on its own queue: the pass calls the AI
  // service once per repair, so it must not queue behind the index sweep's
  // minutes-long `CREATE INDEX CONCURRENTLY`.
  await getVectorReconcileQueue().upsertJobScheduler(
    VECTOR_RECONCILE_SWEEP_JOB,
    { pattern: VECTOR_RECONCILE_CRON, tz: "UTC" },
    { name: VECTOR_RECONCILE_SWEEP_JOB, opts: CRON_OPTS },
  );
};
