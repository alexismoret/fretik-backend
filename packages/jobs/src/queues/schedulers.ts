import {
  CONVERSATION_TASK_SWEEP_JOB,
  DREAMING_SWEEP_JOB,
  GC_DEMOTE_JOB,
  JOURNAL_SWEEP_JOB,
  MCP_SNAPSHOT_REFRESH_JOB,
  WORKFLOW_STALL_SWEEP_JOB,
  WORKFLOW_TRIGGER_SWEEP_JOB,
} from "./names";
import { getMcpRefreshQueue, getMemoryMaintenanceQueue } from "./queues";

/**
 * Repeatable-job registration. BullMQ job schedulers are queue-level state
 * keyed by scheduler id — every replica upserts the same ids, so N replicas
 * still produce ONE job per interval. All land on the maintenance queue: the
 * journal + workflow-trigger sweeps are cheap (reads + enqueue), the nightly
 * triggers fan work out elsewhere, and the stall sweep is one bounded UPDATE.
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

const CRON_OPTS = {
  removeOnComplete: { count: 30 },
  removeOnFail: { count: 100 },
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

  // Dedicated queue — the refresh re-introspects every MCP connection over the
  // network, so it lands here, not on the 15s maintenance queue.
  await getMcpRefreshQueue().upsertJobScheduler(
    MCP_SNAPSHOT_REFRESH_JOB,
    { pattern: MCP_REFRESH_CRON, tz: "UTC" },
    { name: MCP_SNAPSHOT_REFRESH_JOB, opts: CRON_OPTS },
  );
};
