import {
  objectTypesWorthIndexing,
  pruneUnusedFieldIndexes,
  reconcileFieldIndexes,
} from "@fretik/shared/services/object-schema/reconcile-indexes";

/**
 * The autonomous index pass over big object tables.
 *
 * Two other triggers already cover the moments we can see coming — a finished
 * bulk import and a saved page. This one covers the moment nobody signals: a
 * table that crossed the size threshold by growing row by row, and a field
 * whose index has quietly stopped being read.
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
}> => {
  const objectTypeIds = await objectTypesWorthIndexing();
  let created = 0;
  let dropped = 0;

  for (const objectTypeId of objectTypeIds) {
    try {
      created += await reconcileFieldIndexes({ objectTypeId });
      dropped += (await pruneUnusedFieldIndexes({ objectTypeId })).length;
    } catch (cause) {
      console.warn(
        `[object-index-sweep] skipped object type ${objectTypeId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  return { types: objectTypeIds.length, created, dropped };
};
