import db from "../../db";
import type { PageDefinition } from "../../schemas/pages";
import {
  noteIndexWanted,
  reconcileFieldIndexes,
} from "../object-schema/reconcile-indexes";

/**
 * Saving a page is a promise that its object types are about to be read, over
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
    if (dataset.kind !== "objects" || !dataset.objectTypeId) continue;
    const keys = keysByType.get(dataset.objectTypeId) ?? new Set<string>();
    if (dataset.sortBy) keys.add(dataset.sortBy);
    if (dataset.groupBy) keys.add(dataset.groupBy);
    if (dataset.seriesBy) keys.add(dataset.seriesBy);
    for (const filter of dataset.filters ?? []) keys.add(filter.key);
    keysByType.set(dataset.objectTypeId, keys);
  }
  if (keysByType.size === 0) return;

  void (async () => {
    for (const [objectTypeId, keys] of keysByType) {
      try {
        const fields = await db.query.fieldDefinitions.findMany({
          where: { objectTypeId },
        });
        noteIndexWanted({ fields, keys });
        await reconcileFieldIndexes({ objectTypeId });
      } catch (cause) {
        console.warn(
          `[pages] index reconcile skipped for object type ${objectTypeId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  })();
};
