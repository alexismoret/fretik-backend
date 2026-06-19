import {
  createWorkerConnection,
  getProducerConnection,
} from "@fretik/shared/lib/queue/connection";
import { Queue, Worker } from "bullmq";
import { runOrphanCleanup } from "./orphan-cleanup";

/**
 * BullMQ-backed daily cron for the chat-files orphan reaper.
 *
 * Lives inside the @fretik/ai container (this package already owns
 * the chat-file surface end-to-end — storage, services, handlers —
 * so the janitor stays self-contained).
 *
 * Why BullMQ over `setInterval`:
 *  - Deduplication across @fretik/ai replicas. `setInterval` fires
 *    N times in a horizontally-scaled deployment; the Queue's
 *    repeatable-job lock makes sure exactly one replica claims the
 *    daily run.
 *  - Built-in retry / backoff / observability via the Redis queue
 *    which the rest of the stack already runs on.
 *
 * The Queue adds (or idempotently refreshes) a single repeatable
 * job at @fretik/ai boot. The Worker in the same process consumes
 * it and calls `runOrphanCleanup()`. Connections come from the shared
 * BullMQ factory: the producer (fail-fast) for the Queue, a dedicated
 * patient connection for the Worker — never the main `redis` client.
 */

const QUEUE_NAME = "chat-files-maintenance";
const JOB_NAME = "orphan-cleanup";
const REPEAT_PATTERN = process.env.CHAT_FILES_ORPHAN_CRON ?? "0 3 * * *"; // daily at 03:00 UTC

let worker: Worker | null = null;

/**
 * Idempotent — safe to call from the @fretik/ai entrypoint on every
 * boot. Adding the same repeatable key twice is a no-op per BullMQ.
 */
export const registerOrphanCleanupCron = async (): Promise<void> => {
  const queue = new Queue(QUEUE_NAME, { connection: getProducerConnection() });

  await queue.add(
    JOB_NAME,
    {},
    {
      repeat: { pattern: REPEAT_PATTERN },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  if (!worker) {
    worker = new Worker(
      QUEUE_NAME,
      async () => {
        const result = await runOrphanCleanup();
        console.log(
          `[chat-files/orphan-cron] reap complete: scanned=${result.scanned.toString()} deleted=${result.deleted.toString()} failed=${result.failed.toString()}`,
        );
        return result;
      },
      {
        connection: createWorkerConnection(),
        concurrency: 1,
      },
    );

    worker.on("failed", (job, err) => {
      console.error(
        `[chat-files/orphan-cron] job ${job?.id ?? "<unknown>"} failed:`,
        err,
      );
    });
  }
};
