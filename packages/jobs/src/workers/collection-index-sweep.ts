import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import {
  purgeOrphanRecordVectors,
  reconcileCardIndexPolicy,
} from "@fretik/shared/services/collection-records/card-indexing-policy";
import {
  collectionsWorthIndexing,
  pruneUnusedFieldIndexes,
  reconcileFieldIndexes,
} from "@fretik/shared/services/collection-schema/reconcile-indexes";
import { Worker } from "bullmq";
import { COLLECTION_INDEX_QUEUE } from "../queues/names";

/**
 * The autonomous index pass over big collection tables — SQL indexes and semantic
 * cards, which move in opposite directions at the same size.
 *
 * Two other triggers already cover the moments we can see coming — a finished
 * bulk import and a saved page. This one covers the moment nobody signals: a
 * table that crossed the size threshold by growing row by row, and a field
 * whose index has quietly stopped being read.
 *
 * The card pass rides along because this list is already exactly the right set:
 * a type big enough to deserve SQL indexes is a type big enough to stop being
 * embedded row by row. `buildRecordCard` only governs what happens NEXT, so
 * cards written before the crossing survive it — this is what removes them.
 *
 * Sequential on purpose, one type at a time. `CREATE INDEX CONCURRENTLY` is
 * IO-heavy; running the whole estate at once would starve exactly the writes it
 * exists not to block. A type that throws is logged and skipped — the next pass
 * retries it, and one broken table must never stop the sweep.
 */
export const runCollectionIndexSweep = async (): Promise<{
  types: number;
  created: number;
  dropped: number;
  cardsPurged: number;
}> => {
  const collectionIds = await collectionsWorthIndexing();
  let created = 0;
  let dropped = 0;
  // Orphans belong to types that no longer exist, so no per-type pass can find
  // them — this one statement is the only thing that can.
  let cardsPurged = await purgeOrphanRecordVectors();

  for (const collectionId of collectionIds) {
    try {
      created += await reconcileFieldIndexes({ collectionId });
      dropped += (await pruneUnusedFieldIndexes({ collectionId })).length;
      cardsPurged += await reconcileCardIndexPolicy({ collectionId });
    } catch (cause) {
      console.warn(
        `[collection-index-sweep] skipped collection ${collectionId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  return { types: collectionIds.length, created, dropped, cardsPurged };
};

/**
 * Own worker on its own queue, for the reason `names.ts` records: one pass can
 * hold a `CREATE INDEX CONCURRENTLY` for minutes, and the maintenance queue
 * runs at concurrency 1 with the 15s journal and workflow-trigger sweeps behind
 * it. Concurrency 1 here too — the sweep is already sequential per type on
 * purpose, and a second pass would only contend for the same tables.
 */
export const startCollectionIndexWorker = (): Worker => {
  const worker = new Worker(
    COLLECTION_INDEX_QUEUE,
    async () => {
      const { types, created, dropped, cardsPurged } =
        await runCollectionIndexSweep();
      if (created > 0 || dropped > 0 || cardsPurged > 0) {
        console.info(
          `[collection-index-sweep] ${types.toString()} types: built ${created.toString()} indexes, retired ${dropped.toString()}, purged ${cardsPurged.toString()} record cards`,
        );
      }
    },
    { connection: createWorkerConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[collection-index-sweep] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
