import { Queue } from "bullmq";
import type { CollectionSyncRunTrigger } from "../../db/schema";
import { getProducerConnection } from "../../lib/queue/connection";

/**
 * The queue a sync run is handed to.
 *
 * Producer accessor in `shared`, consumer in `@fretik/jobs` — the
 * `bulk-operation` pattern, for the same reason: the producers are the API's
 * refresh endpoint, the agent's `refreshSync` tool and the collection-open
 * path, and `@fretik/api` must never import `@fretik/jobs`. The jobs package
 * re-exports the name and the payload from here so there is exactly one of
 * each.
 *
 * NOT the maintenance queue, which runs at concurrency 1 behind a 15 s journal
 * sweep: one run walks a third party for up to `SYNC_LIMITS.runBudgetMs` and
 * would stop every other sweep for as long as it lasted. Same reasoning as
 * `mcp-refresh` and `collection-index`.
 */
export const EXTERNAL_SYNC_QUEUE = "external-sync";

/** Job name on {@link EXTERNAL_SYNC_QUEUE}. */
export const EXTERNAL_SYNC_RUN_JOB = "sync-source";

export interface ExternalSyncJobData {
  sourceId: string;
  teamId: string;
  trigger: CollectionSyncRunTrigger;
  /**
   * `lookup` only — records to refresh FIRST. A hint, not the work list: the
   * durable signal is `record_sync_state.status = 'pending'`, written before
   * the enqueue, so a job lost to a Redis restart costs latency and not the
   * refresh itself.
   */
  recordIds?: string[];
  triggeredByUserId?: string | null;
  /**
   * The sweep already took the claim before enqueuing (its `UPDATE … RETURNING`
   * IS the claim). Without this the runner would try to claim a source it has
   * itself been handed and drop every scheduled run as a duplicate.
   */
  preClaimed?: boolean;
}

let queue: Queue<ExternalSyncJobData> | null = null;

export const getExternalSyncQueue = (): Queue<ExternalSyncJobData> => {
  queue ??= new Queue<ExternalSyncJobData>(EXTERNAL_SYNC_QUEUE, {
    connection: getProducerConnection(),
  });
  return queue;
};

/**
 * Job id for a source. ONE pending job per source, always: a double-click, a
 * scheduled tick landing on a manual refresh, and the collection-open path all
 * collapse into the same id.
 *
 * BullMQ refuses an `add` whose jobId exists in ANY state, completed included,
 * which is why both retentions below are `true` (delete immediately) rather
 * than a count: a kept job would lock the source out of every later refresh
 * until it aged out. The history this would have provided already exists, in a
 * better place — `collection_sync_runs`, which survives a Redis flush and is
 * what the UI reads.
 */
export const syncJobId = (sourceId: string): string => `sync-${sourceId}`;
