import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import {
  purgeOrphanRecordVectors,
  reconcileCardIndexPolicy,
} from "@fretik/shared/services/object-records/card-indexing-policy";
import {
  objectTypesWorthIndexing,
  pruneUnusedFieldIndexes,
  reconcileFieldIndexes,
} from "@fretik/shared/services/object-schema/reconcile-indexes";
import { Worker } from "bullmq";
import { OBJECT_INDEX_QUEUE } from "../queues/names";

/**
 * The autonomous index pass over big object tables — SQL indexes and semantic
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
export const runObjectIndexSweep = async (): Promise<{
  types: number;
  created: number;
  dropped: number;
  cardsPurged: number;
}> => {
  const objectTypeIds = await objectTypesWorthIndexing();
  let created = 0;
  let dropped = 0;
  // Orphans belong to types that no longer exist, so no per-type pass can find
  // them — this one statement is the only thing that can.
  let cardsPurged = await purgeOrphanRecordVectors();

  for (const objectTypeId of objectTypeIds) {
    try {
      created += await reconcileFieldIndexes({ objectTypeId });
      dropped += (await pruneUnusedFieldIndexes({ objectTypeId })).length;
      cardsPurged += await reconcileCardIndexPolicy({ objectTypeId });
    } catch (cause) {
      console.warn(
        `[object-index-sweep] skipped object type ${objectTypeId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  return { types: objectTypeIds.length, created, dropped, cardsPurged };
};

/**
 * Own worker on its own queue, for the reason `names.ts` records: one pass can
 * hold a `CREATE INDEX CONCURRENTLY` for minutes, and the maintenance queue
 * runs at concurrency 1 with the 15s journal and workflow-trigger sweeps behind
 * it. Concurrency 1 here too — the sweep is already sequential per type on
 * purpose, and a second pass would only contend for the same tables.
 */
export const startObjectIndexWorker = (): Worker => {
  const worker = new Worker(
    OBJECT_INDEX_QUEUE,
    async () => {
      const { types, created, dropped, cardsPurged } =
        await runObjectIndexSweep();
      if (created > 0 || dropped > 0 || cardsPurged > 0) {
        console.info(
          `[object-index-sweep] ${types.toString()} types: built ${created.toString()} indexes, retired ${dropped.toString()}, purged ${cardsPurged.toString()} record cards`,
        );
      }
    },
    { connection: createWorkerConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[object-index-sweep] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
