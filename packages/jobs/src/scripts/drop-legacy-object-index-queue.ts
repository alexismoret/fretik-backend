import { getProducerConnection } from "@fretik/shared/lib/queue/connection";
import { Queue } from "bullmq";

/**
 * One-shot cleanup for the `objects` -> `collections` rename.
 *
 * Renaming the queue constant creates a NEW scheduler on `collection-index` and
 * leaves the old `object-index` one alive in Redis: it keeps enqueuing a nightly
 * sweep onto a queue no worker consumes, silently and forever. Nothing errors,
 * so this has to be run once per environment after the deploy.
 *
 * Run: `bun --env-file=.env run src/scripts/drop-legacy-object-index-queue.ts`
 */
const run = async (): Promise<void> => {
  const legacy = new Queue("object-index", {
    connection: getProducerConnection(),
  });
  await legacy.obliterate({ force: true });
  await legacy.close();
  console.log("[cleanup] obliterated the legacy `object-index` queue");
  process.exit(0);
};

run().catch((error: unknown) => {
  console.error("[cleanup] failed:", error);
  process.exit(1);
});
