import { hasCapability } from "../../../authz/gates";
import { loadPrincipal } from "../../../authz/load-principal";
import { partitionMirrorWrites } from "../../../authz/mirror-writes";
import type { BulkOperation } from "../../../db/schema";
import { idsInCollection } from "../../collection-records/ids-in-collection";
import {
  RECORD_DELETION_REFUSAL,
  recordsShortOfFull,
} from "../../collection-sharing/write-access";

/**
 * The ids of a chunk this load may write, and why each other one may not.
 *
 * A record of another collection is reported, never written (the executors'
 * docblocks say why). So is a record that mirrors a file kept from the person
 * who launched the load, unless they may edit that file
 * (`authz/mirror-writes.ts`): a load writes for someone, with their access,
 * however long after the approval its last chunk runs. Someone no longer in
 * the organization writes nothing, nor does someone who has become a viewer
 * of the team. And a delete removes a record someone else created only for a
 * person with full access to the team's content (the team's policy).
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
  const refuseAll = (error: string) => {
    for (const id of inCollection) refused.set(id, error);
    return { writable: new Set<string>(), refused };
  };
  if (principal === null) {
    return refuseAll(
      "The person this load writes for is no longer in the organization.",
    );
  }
  if (
    !(await hasCapability({
      principal,
      capability: "team.content.create",
      teamId: op.teamId,
    }))
  ) {
    return refuseAll(
      "The person this load writes for can no longer change the team's content.",
    );
  }
  const mirrors = await partitionMirrorWrites({
    principal,
    recordIds: [...inCollection],
  });
  for (const { id, error } of mirrors.refused) refused.set(id, error);

  const writable = new Set(mirrors.writable);
  if (op.params.op === "delete") {
    const held = await recordsShortOfFull({
      principal,
      teamId: op.teamId,
      recordIds: [...writable],
    });
    for (const { id } of held) {
      writable.delete(id);
      refused.set(id, RECORD_DELETION_REFUSAL);
    }
  }
  return { writable, refused };
};
