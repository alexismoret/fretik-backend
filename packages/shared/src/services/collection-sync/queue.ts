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
  /**
   * This job continues a walk that ran out of budget, rejoining its run row
   * rather than opening a new one.
   *
   * The run id is carried so a SCHEDULED tick landing on a suspended source
   * cannot adopt a checkpoint it was not handed: the runner compares the two
   * and starts over when they disagree.
   */
  continueFrom?: { runId: string };
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

/**
 * Hand a suspended walk back to the queue so its next leg runs.
 *
 * The SAME job id, deliberately: the source already holds its claim (the leg
 * renewed it rather than releasing it), so a manual refresh arriving now would
 * be dropped as a duplicate anyway — and collapsing onto one id keeps the
 * invariant that a source has at most one job in flight, whatever asked for it.
 *
 * `priority` is inherited rather than re-derived. A walk that was urgent when
 * it started is still urgent on its fourth leg, and a continuation that fell to
 * the back of the queue behind every other team's first leg would make a long
 * load take longer the longer it got.
 */
export const enqueueContinuation = async (input: {
  sourceId: string;
  teamId: string;
  trigger: CollectionSyncRunTrigger;
  runId: string;
  /** `rate_limited` only — how long the third party asked us to wait. */
  delayMs?: number;
  priority?: number;
}): Promise<void> => {
  await getExternalSyncQueue().add(
    EXTERNAL_SYNC_RUN_JOB,
    {
      sourceId: input.sourceId,
      teamId: input.teamId,
      trigger: input.trigger,
      preClaimed: true,
      continueFrom: { runId: input.runId },
    },
    {
      jobId: syncJobId(input.sourceId),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
      ...(input.delayMs !== undefined && input.delayMs > 0
        ? { delay: input.delayMs }
        : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  );
};
