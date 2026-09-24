import { loadPrincipal } from "../../../authz/load-principal";
import { partitionMirrorWrites } from "../../../authz/mirror-writes";
import type { BulkOperation } from "../../../db/schema";
import { idsInCollection } from "../../collection-records/ids-in-collection";

/**
 * The ids of a chunk this load may write, and why each other one may not.
 *
 * A record of another collection is reported, never written (the executors'
 * docblocks say why). So is a record that mirrors a file kept from the person
 * who launched the load, unless they may edit that file
 * (`authz/mirror-writes.ts`): a load writes for someone, with their access,
 * however long after the approval its last chunk runs. Someone no longer in
 * the organization writes nothing.
 */
export const writableIds = async (
  op: BulkOperation,
  ids: readonly string[],
): Promise<{ writable: Set<string>; refused: Map<string, string> }> => {
  const refused = new Map<string, string>();
  const inCollection = await idsInCollection({
    teamId: op.teamId,
    collectionId: op.params.collectionId,
    ids: [...ids],
  });
  for (const id of ids) {
    if (!inCollection.has(id)) {
      refused.set(id, `Record ${id} is not in ${op.params.collectionKey}.`);
    }
  }

  const principal = await loadPrincipal({
    organizationId: op.organizationId,
    userId: op.userId,
  });
  if (principal === null) {
    for (const id of inCollection) {
      refused.set(
        id,
        "The person this load writes for is no longer in the organization.",
      );
    }
    return { writable: new Set(), refused };
  }
  const mirrors = await partitionMirrorWrites({
    principal,
    recordIds: [...inCollection],
  });
  for (const { id, error } of mirrors.refused) refused.set(id, error);
  return { writable: new Set(mirrors.writable), refused };
};
