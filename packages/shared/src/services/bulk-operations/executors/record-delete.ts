import db from "../../../db";
import type {
  BulkOperation,
  ToolApprovalRecordImportPayload,
} from "../../../db/schema";
import { bulkDeleteCollectionRecords } from "../../collection-records/bulk-delete";
import { idsInCollection } from "../../collection-records/ids-in-collection";
import { getRecordSnapshots } from "../../collection-records/snapshot-batch";
import type { EventActor } from "../../domain-events/emit";
import { importAgentKey } from "../agent-key";
import type { BulkOperationExecutor, ChunkOutcome } from "../types";
import { MALFORMED_ROW, readTargetId } from "./rows";

/**
 * `record_delete` — many records of ONE collection, removed in chunks.
 *
 * ONE TRANSACTION PER CHUNK, and that is the whole reason this executor is not
 * a one-line call. `bulkDeleteCollectionRecords` splits its own work by the
 * parameter ceiling and, left to itself, gives each of those splits its own
 * transaction — which is right for a caller holding the request, and wrong
 * here: the ledger stamps a chunk as applied or not at all, so a chunk that
 * half-committed would be reported as failed while its rows are already gone.
 * Passing `tx` folds every split into one commit and restores the equality the
 * exactly-once guard rests on: the chunk failed ⇒ nothing was deleted.
 *
 * As with an update, the collection is a filter and not a label: an id outside
 * it is reported, never deleted. A load approved as "40 000 stale orders" must
 * not be able to remove a contact.
 */

const actorFor = (op: BulkOperation): EventActor => ({
  actorType: "connector",
  actorUserId: op.userId,
  conversationId: op.conversationId,
  agentKey: importAgentKey(op.id),
});

const ownedIds = (op: BulkOperation, ids: string[]): Promise<Set<string>> =>
  idsInCollection({
    teamId: op.teamId,
    collectionId: op.params.collectionId,
    ids,
  });

/** Ids that are not this collection's, as positional failures. */
const strayErrors = async (
  op: BulkOperation,
  parsed: (string | null)[],
): Promise<{ errors: { index: number; error: string }[]; ids: string[] }> => {
  const errors = parsed.flatMap((id, index) =>
    id === null ? [{ index, error: MALFORMED_ROW("`{id}`") }] : [],
  );
  const ids = parsed.flatMap((id) => (id === null ? [] : [id]));
  const owned = await ownedIds(op, ids);
  parsed.forEach((id, index) => {
    if (id === null || owned.has(id)) return;
    errors.push({
      index,
      error: `Record ${id} is not in ${op.params.collectionKey}.`,
    });
  });
  return { errors, ids: ids.filter((id) => owned.has(id)) };
};

export const recordDeleteExecutor: BulkOperationExecutor = {
  kind: "record_delete",

  // A delete has no field data to validate — the only thing that can be wrong
  // about it before it runs is the target, so that is what the sample checks.
  validateSample: async (op) =>
    (await strayErrors(op, op.sample.map(readTargetId))).errors,

  applyChunk: async ({ op, items }): Promise<ChunkOutcome> => {
    const { errors, ids } = await strayErrors(op, items.map(readTargetId));
    if (ids.length === 0) {
      return { succeeded: 0, failed: errors.length, errors };
    }

    // One commit for the chunk — see the module docblock.
    const result = await db.transaction((tx) =>
      bulkDeleteCollectionRecords({
        teamId: op.teamId,
        ids,
        actor: actorFor(op),
        tx,
      }),
    );

    const indexById = new Map(
      items.map((item, index) => [readTargetId(item), index]),
    );
    for (const failure of result.errors) {
      errors.push({
        index: indexById.get(failure.id) ?? -1,
        error: failure.error,
      });
    }

    return {
      succeeded: result.deletedIds.length,
      failed: errors.length,
      errors,
    };
  },

  // The rows are gone; their extension rows, links and vectors went with them
  // through the cascade the delete service already drives.
  finalize: () => Promise.resolve(),

  buildApprovalPayload: async (
    op,
  ): Promise<ToolApprovalRecordImportPayload> => {
    const collection = await db.query.collections.findFirst({
      columns: { label: true, icon: true, color: true },
      where: { id: op.params.collectionId },
    });
    const ids = op.sample.flatMap((item) => readTargetId(item) ?? []);
    // What is about to be destroyed, in full, for the three sample rows — the
    // only evidence that makes a deletion of this size reviewable.
    const snapshots = await getRecordSnapshots({ teamId: op.teamId, ids });
    return {
      op: "delete",
      operationId: op.id,
      totalRows: op.totalItems,
      collectionKey: op.params.collectionKey,
      collectionId: op.params.collectionId,
      ...(collection?.label ? { typeName: collection.label } : {}),
      ...(collection?.icon ? { typeIcon: collection.icon } : {}),
      ...(collection?.color ? { typeColor: collection.color } : {}),
      items: ids.map((id) => {
        const snapshot = snapshots.get(id);
        return {
          recordId: id,
          collectionId: op.params.collectionId,
          collectionKey: op.params.collectionKey,
          ...(snapshot ? { currentLabel: snapshot.label } : {}),
          ...(snapshot ? { currentData: snapshot.data } : {}),
        };
      }),
    };
  },

  describe: (op) =>
    `Deleting ${op.totalItems.toString()} records from ${op.params.collectionKey}`,
};
