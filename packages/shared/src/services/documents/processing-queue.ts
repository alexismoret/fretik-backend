import { type Job, Queue, Worker } from "bullmq";

import {
  createWorkerConnection,
  getProducerConnection,
} from "../../lib/queue/connection";
import {
  type DocumentProcessingJobData,
  finalizeFailedDocument,
  processDocument,
} from "./process";

export type { DocumentProcessingJobData } from "./process";

/**
 * BullMQ queue for the document-processing pipeline (OCR → extraction →
 * vectorise). Producers (`@fretik/api` upload route, `@fretik/ai`
 * Save-on-drive) enqueue; the Worker runs IN-PROCESS inside every
 * `@fretik/api` replica (`startDocumentProcessingWorker`), so processing
 * scales by adding API replicas and never blocks the AI service.
 *
 * Robustness this buys over the old fire-and-forget promise:
 *  - jobs survive a process crash and are reclaimed (no documents stuck
 *    forever in `processing`),
 *  - transient failures (pre-extract timeout, S3 blip) retry with backoff,
 *  - per-replica concurrency caps protect the event loop under a burst.
 */

const QUEUE_NAME = "document-processing";
const JOB_NAME = "process";
const MAX_ATTEMPTS = 3;

// Document jobs are I/O-bound — most wall-time is spent waiting on the AI
// service (`/internal/pre-extract` blocks up to 3 min on Mistral OCR) and
// S3 / Gotenberg, not on the API replica's CPU. So a modestly high
// per-replica concurrency overlaps those waits well. The real ceilings are
// downstream (the AI service's own caps + Mistral rate limits) and memory
// (~10-30 MB of buffers per in-flight job), and total load is
// concurrency × replicas — hence a conservative-but-not-tiny default of 5,
// raised via env once a deployment confirms headroom.
const DEFAULT_CONCURRENCY = 5;

const resolveConcurrency = (): number => {
  const raw = Number.parseInt(
    process.env.DOCUMENT_WORKER_CONCURRENCY ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONCURRENCY;
};

let queue: Queue<DocumentProcessingJobData> | null = null;
let worker: Worker<DocumentProcessingJobData> | null = null;

const getQueue = (): Queue<DocumentProcessingJobData> => {
  if (queue) return queue;
  queue = new Queue<DocumentProcessingJobData>(QUEUE_NAME, {
    connection: getProducerConnection(),
  });
  return queue;
};

/**
 * Enqueue one document for background processing. `jobId = documentId`
 * makes the enqueue idempotent — the same document can't be queued twice
 * concurrently. Fails fast (producer connection) if Redis is unreachable.
 */
export const enqueueDocumentProcessing = async (
  data: DocumentProcessingJobData,
): Promise<void> => {
  await getQueue().add(JOB_NAME, data, {
    jobId: data.documentId,
    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  });
};

/**
 * Re-enqueue a document for a forced re-extraction. `jobId = documentId` is
 * retained after completion, so BullMQ would silently dedup a plain re-`add`;
 * drop the retained job first, then add with `force` set. If the job is still
 * active the remove is a no-op and the caller should retry once it settles.
 */
export const reenqueueDocumentProcessing = async (
  data: DocumentProcessingJobData,
): Promise<void> => {
  const q = getQueue();
  await q.remove(data.documentId).catch(() => {});
  await q.add(
    JOB_NAME,
    { ...data, force: true },
    {
      jobId: data.documentId,
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    },
  );
};

/**
 * Start the in-process document-processing Worker. Idempotent — safe to
 * call once at `@fretik/api` boot on every replica. Only API replicas
 * should call this; `@fretik/ai` is a producer only.
 */
export const startDocumentProcessingWorker = (): void => {
  if (worker) return;

  worker = new Worker<DocumentProcessingJobData>(
    QUEUE_NAME,
    async (job: Job<DocumentProcessingJobData>) => {
      await processDocument(job.data);
    },
    {
      connection: createWorkerConnection(),
      concurrency: resolveConcurrency(),
    },
  );

  worker.on("failed", (job, err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!job) {
      console.error("[document-processing] job failed (no job ref):", message);
      return;
    }
    console.error(
      `[document-processing] job ${job.id ?? "<unknown>"} failed (attempt ${job.attemptsMade.toString()}/${MAX_ATTEMPTS.toString()}):`,
      message,
    );
    // Terminal failure — retries exhausted. Flip the document to `error`
    // and refund storage / cleanup S3.
    if (job.attemptsMade >= (job.opts.attempts ?? MAX_ATTEMPTS)) {
      finalizeFailedDocument(job.data, message).catch((cleanupErr: unknown) => {
        console.error(
          `[document-processing] terminal cleanup failed for ${job.data.documentId}:`,
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        );
      });
    }
  });

  worker.on("error", (err) => {
    console.error(
      "[document-processing] worker error:",
      err instanceof Error ? err.message : err,
    );
  });
};
