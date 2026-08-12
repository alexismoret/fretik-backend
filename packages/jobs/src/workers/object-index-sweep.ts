import {
  purgeOrphanRecordVectors,
  reconcileCardIndexPolicy,
} from "@fretik/shared/services/object-records/card-indexing-policy";
import {
  objectTypesWorthIndexing,
  pruneUnusedFieldIndexes,
  reconcileFieldIndexes,
} from "@fretik/shared/services/object-schema/reconcile-indexes";

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
