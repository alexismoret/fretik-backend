import { type Job, Queue, Worker } from "bullmq";
import {
  createWorkerConnection,
  getProducerConnection,
} from "../../lib/queue/connection";
import { drainBulkOperation, failBulkOperation } from "./runner";

/**
 * The queue a granted bulk operation is drained on.
 *
 * Queue and Worker live together in `shared` (the document-processing pattern)
 * for one concrete reason: the PRODUCER is the API's approval-grant handler,
 * and `@fretik/api` must never import `@fretik/jobs`. Keeping the accessor here
 * gives the grant a one-line enqueue, while `@fretik/jobs` owns the process
 * that actually consumes.
 */

export const BULK_OPERATION_QUEUE = "bulk-operation";
const JOB_NAME = "drain";

/**
 * Low on purpose. A drain is a long sequence of large write transactions
 * against ONE object type; running several at once mostly means they contend
 * for the same table's locks and WAL bandwidth, and a bigger number would buy
 * throughput only for the rare case of unrelated types importing at once.
 */
const DEFAULT_CONCURRENCY = 2;

/**
 * Generous. A retry costs nothing (applied chunks are stamped and skipped) and
 * the failures this covers are transient by nature — a connection blip, a
 * deadlock, a restart mid-load. Giving up early on a 200 000-row import the
 * user already approved is the worse failure.
 */
const MAX_ATTEMPTS = 5;

export interface BulkOperationJobData {
  operationId: string;
}

let queue: Queue<BulkOperationJobData> | null = null;
let worker: Worker<BulkOperationJobData> | null = null;

const getQueue = (): Queue<BulkOperationJobData> => {
  queue ??= new Queue<BulkOperationJobData>(BULK_OPERATION_QUEUE, {
    connection: getProducerConnection(),
  });
  return queue;
};

const resolveConcurrency = (): number => {
  const raw = Number.parseInt(process.env.BULK_OPERATION_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONCURRENCY;
};

/**
 * Hand a granted operation to the worker. `jobId = bulkop-<id>` makes a
 * double-grant (a double-click, a retried request) a BullMQ no-op rather than
 * two concurrent drains of the same chunks.
 */
export const enqueueBulkOperation = async (
  operationId: string,
): Promise<void> => {
  await getQueue().add(
    JOB_NAME,
    { operationId },
    {
      jobId: `bulkop-${operationId}`,
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    },
  );
};

/** Start the in-process drain Worker. Idempotent; `@fretik/jobs` calls it. */
export const startBulkOperationWorker = (): void => {
  if (worker) return;
  worker = new Worker<BulkOperationJobData>(
    BULK_OPERATION_QUEUE,
    async (job: Job<BulkOperationJobData>) => {
      await drainBulkOperation(job.data.operationId);
    },
    {
      connection: createWorkerConnection(),
      concurrency: resolveConcurrency(),
      // A drain of 100 chunks holds the job for minutes without touching
      // Redis; the default 30s stall check would declare it dead and start a
      // second one against the same chunks.
      stalledInterval: 5 * 60_000,
      lockDuration: 5 * 60_000,
    },
  );
  worker.on("failed", (job, err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[bulk-operation] job ${job?.id ?? "<unknown>"} failed:`,
      message,
    );
    // Out of retries. Somebody has to say the load is over, and only this
    // knows: a `running` operation reads as "still going" to the wait
    // registry, so without this its task stays pending forever — blocking not
    // just this conversation's resume but every later task in it. The counters
    // rebuilt from the ledger go into the report, so a partial load is
    // reported as partial rather than lost.
    if (job === undefined || job.attemptsMade < MAX_ATTEMPTS) return;
    void failBulkOperation(
      job.data.operationId,
      `The import stopped after ${MAX_ATTEMPTS.toString()} attempts: ${message}`,
    ).catch((cause: unknown) => {
      console.error(
        `[bulk-operation] could not mark ${job.data.operationId} failed:`,
        cause instanceof Error ? cause.message : cause,
      );
    });
  });
};
