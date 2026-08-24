import { type Job, Queue, Worker } from "bullmq";

import {
  createWorkerConnection,
  getProducerConnection,
} from "../../lib/queue/connection";
import { triggerDocumentVectorRefresh } from "./vector-refresh";

/**
 * Debounced re-indexing of a document that keeps changing.
 *
 * An in-app editor autosaves every few seconds; re-chunking, re-enriching and
 * re-embedding at that rate costs more than writing the document. So a save
 * does not re-index — it schedules a re-index 30 s out, and each further save
 * pushes that deadline back. The pass that eventually runs reads the CURRENT
 * bytes off S3, so a burst costs ONE indexing of the final text.
 *
 * Why a queue rather than a `setTimeout`: producers run in several processes
 * (api, ai, jobs) and several replicas each, so consecutive saves of one
 * document land in different memory spaces. Per-process timers would each fire
 * — N producers, N passes — and worse, `/internal/vectorize` DELETEs a source's
 * rows before re-INSERTing, so two overlapping passes can interleave into
 * duplicated vectors. A delayed BullMQ job keyed `jobId = documentId` gives
 * cross-process debouncing AND single execution by construction, and survives
 * a restart.
 *
 * Same split as `processing-queue.ts`: the queue + worker pair lives here
 * because producers are shared services, and `@fretik/jobs` hosts the Worker.
 */

const QUEUE_NAME = "document-vector-refresh";
const JOB_NAME = "refresh";
const DEBOUNCE_MS = 30_000;
const MAX_ATTEMPTS = 2;

/**
 * A pass is downstream-bound — most of its wall time is the AI service
 * chunking, enriching and embedding, behind ITS own caps
 * (`AI_EMBEDDING_PARALLEL_CALLS`, the `openrouter:embeddings` semaphore). So
 * the useful number here is "enough to keep those caps fed", and raising it
 * past them only moves the queue. Matches the document-processing default;
 * `DOCUMENT_VECTOR_REFRESH_CONCURRENCY` is the dial when a deployment shows
 * the backlog growing rather than the AI service saturating.
 */
const DEFAULT_CONCURRENCY = 5;

const resolveConcurrency = (): number => {
  const raw = Number.parseInt(
    process.env.DOCUMENT_VECTOR_REFRESH_CONCURRENCY ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONCURRENCY;
};

export interface DocumentVectorRefreshJobData {
  documentId: string;
  teamId: string;
  organizationId: string;
}

let queue: Queue<DocumentVectorRefreshJobData> | null = null;
let worker: Worker<DocumentVectorRefreshJobData> | null = null;

const getQueue = (): Queue<DocumentVectorRefreshJobData> => {
  if (queue) return queue;
  queue = new Queue<DocumentVectorRefreshJobData>(QUEUE_NAME, {
    connection: getProducerConnection(),
  });
  return queue;
};

/**
 * (Re)arm the debounce for one document.
 *
 * Drops the pending job before re-adding: a delayed job with the same `jobId`
 * would otherwise be silently deduped and the deadline would never move, which
 * turns the trailing-edge debounce into a leading-edge one that indexes the
 * FIRST keystroke's text. `removeOnComplete`/`removeOnFail` free the id as soon
 * as the pass ends — a retained terminal job would swallow the next save's
 * schedule entirely (the trap documented on `reenqueueDocumentProcessing`).
 *
 * Best-effort, like `triggerDocumentVectorRefresh` itself: a save must not fail
 * because the index could not be scheduled.
 */
export const scheduleDocumentVectorRefresh = async (
  data: DocumentVectorRefreshJobData,
): Promise<void> => {
  try {
    const q = getQueue();
    await q.remove(data.documentId).catch(() => {});
    await q.add(JOB_NAME, data, {
      jobId: data.documentId,
      delay: DEBOUNCE_MS,
      attempts: MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  } catch (error) {
    console.error(
      `[document-vector-refresh] Failed to schedule for ${data.documentId}:`,
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Start the in-process Worker. Idempotent — called once at `@fretik/jobs` boot,
 * alongside `startDocumentProcessingWorker`.
 */
export const startDocumentVectorRefreshWorker = (): void => {
  if (worker) return;

  worker = new Worker<DocumentVectorRefreshJobData>(
    QUEUE_NAME,
    async (job: Job<DocumentVectorRefreshJobData>) => {
      const { documentId, teamId, organizationId } = job.data;
      await triggerDocumentVectorRefresh(documentId, teamId, organizationId);
    },
    {
      connection: createWorkerConnection(),
      concurrency: resolveConcurrency(),
    },
  );

  worker.on("error", (err) => {
    console.error(
      "[document-vector-refresh] worker error:",
      err instanceof Error ? err.message : err,
    );
  });
};
