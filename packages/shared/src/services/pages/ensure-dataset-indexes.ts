import db from "../../db";
import type { PageDefinition } from "../../schemas/pages";
import {
  noteIndexWanted,
  reconcileFieldIndexes,
} from "../collection-schema/reconcile-indexes";

/**
 * Saving a page is a promise that its collections are about to be read, over
 * and over, by every viewer — so it is one of the moments worth reconciling
 * indexes on, alongside a finished bulk import and the maintenance sweep.
 *
 * It is also the moment that closes the resurrection half of the loop: a field
 * the maintenance pass had dropped as unused is wanted again the instant a page
 * declares a filter or a sort on it.
 *
 * Fire-and-forget by design — the caller must NOT await it. `CREATE INDEX
 * CONCURRENTLY` scales with the table, and a page write has no reason to block
 * on it: until the index exists the same queries run, just sorted rather than
 * walked. Failures are swallowed for the same reason — saving a page must never
 * fail because an index did.
 *
 * (One of the package's deliberate exceptions to "always await", alongside
 * `wakeWaitingDocumentExecutions`.)
 */
export const ensurePageDatasetIndexes = (input: {
  definition: PageDefinition;
}): void => {
  const keysByType = new Map<string, Set<string>>();
  for (const dataset of input.definition.datasets) {
    if (dataset.kind !== "collections" || !dataset.collectionId) continue;
    const keys = keysByType.get(dataset.collectionId) ?? new Set<string>();
    if (dataset.sortBy) keys.add(dataset.sortBy);
    if (dataset.groupBy) keys.add(dataset.groupBy);
    if (dataset.seriesBy) keys.add(dataset.seriesBy);
    for (const filter of dataset.filters ?? []) keys.add(filter.key);
    keysByType.set(dataset.collectionId, keys);
  }
  if (keysByType.size === 0) return;

  void (async () => {
    for (const [collectionId, keys] of keysByType) {
      try {
        const fields = await db.query.fieldDefinitions.findMany({
          where: { collectionId },
        });
        noteIndexWanted({ fields, keys });
        await reconcileFieldIndexes({ collectionId });
      } catch (cause) {
        console.warn(
          `[pages] index reconcile skipped for collection ${collectionId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  })();
};
