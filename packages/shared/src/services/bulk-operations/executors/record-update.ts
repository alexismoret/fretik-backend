import db from "../../../db";
import type {
  BulkOperation,
  ToolApprovalRecordImportPayload,
} from "../../../db/schema";
import { bulkUpdateCollectionRecords } from "../../collection-records/bulk-update";
import { getRecordSnapshots } from "../../collection-records/snapshot-batch";
import type { EventActor } from "../../domain-events/emit";
import { importAgentKey } from "../agent-key";
import type { BulkOperationExecutor, ChunkOutcome } from "../types";
import { MALFORMED_ROW, readUpdateRow } from "./rows";
import { writableIds } from "./writable-ids";

/**
 * `record_update` — many existing records of ONE collection, rewritten in
 * chunks.
 *
 * The sibling of `record_import`, and it exists for the same reason at the same
 * size: a re-mapping that touches 80 000 rows cannot travel as one request, be
 * reviewed row by row, or die with the tab that approved it. Every row still
 * goes through `bulkUpdateCollectionRecords`, so validation, the identity and
 * search recompute and the `record.updated` diff are exactly a small write's.
 *
 * Two things it does that the inline path does not:
 *
 *  - **The collection is a filter, not a label.** An inline `bulk_update` may
 *    span types, because each row carries its own. A streamed one cannot: the
 *    chunk size was computed from one collection's column width, and the card
 *    named one collection. An id belonging to another is reported, never
 *    written — otherwise a load approved as "80 000 invoices" could rewrite a
 *    contact, in a chunk sized for the wrong table.
 *  - **`agentKey: "import:<id>"`**, so the workflow trigger sweep looks away.
 *    A migration is not a business event stream: without it, re-mapping
 *    80 000 orders in a team that runs "when an order changes, notify the
 *    carrier" sends 80 000 notifications.
 *
 * Synced columns stay refused (`allowSyncedFields` is left off): an app owns
 * them, and a load that overwrote them would be undone by the next refresh
 * anyway.
 */

const actorFor = (op: BulkOperation): EventActor => ({
  actorType: "connector",
  actorUserId: op.userId,
  conversationId: op.conversationId,
  agentKey: importAgentKey(op.id),
});

const mergeOf = (op: BulkOperation): boolean =>
  op.params.op === "update" ? op.params.merge : false;

export const recordUpdateExecutor: BulkOperationExecutor = {
  kind: "record_update",

  validateSample: async (op) => {
    const parsed = op.sample.map(readUpdateRow);
    const errors = parsed.flatMap((row, index) =>
      row === null ? [{ index, error: MALFORMED_ROW("`{id, data}`") }] : [],
    );
    const updates = parsed.flatMap((row) => (row === null ? [] : [row]));
    if (updates.length === 0) return errors;

    const { writable, refused } = await writableIds(
      op,
      updates.map((u) => u.id),
    );
    const { errors: validationErrors } = await bulkUpdateCollectionRecords({
      teamId: op.teamId,
      updates: updates.filter((u) => writable.has(u.id)),
      merge: mergeOf(op),
      dryRun: true,
    });

    // Positions are the caller's original ones, so a reported failure points
    // at a line of the list it sent.
    const indexById = new Map(parsed.map((row, index) => [row?.id, index]));
    return [
      ...errors,
      ...[...refused].map(([id, error]) => ({
        index: indexById.get(id) ?? -1,
        error,
      })),
      ...validationErrors.map((e) => ({
        index: indexById.get(e.id) ?? -1,
        error: e.error,
      })),
    ];
  },

  applyChunk: async ({ op, items }): Promise<ChunkOutcome> => {
    const parsed = items.map(readUpdateRow);
    const errors = parsed.flatMap((row, index) =>
      row === null ? [{ index, error: MALFORMED_ROW("`{id, data}`") }] : [],
    );
    const updates = parsed.flatMap((row) => (row === null ? [] : [row]));
    const indexById = new Map(parsed.map((row, index) => [row?.id, index]));

    const { writable, refused } = await writableIds(
      op,
      updates.map((u) => u.id),
    );
    for (const [id, error] of refused) {
      errors.push({ index: indexById.get(id) ?? -1, error });
    }

    const result = await bulkUpdateCollectionRecords({
      teamId: op.teamId,
      updates: updates.filter((u) => writable.has(u.id)),
      merge: mergeOf(op),
      actor: actorFor(op),
    });
    for (const failure of result.errors) {
      errors.push({
        index: indexById.get(failure.id) ?? -1,
        error: failure.error,
      });
    }

    return {
      succeeded: result.updatedIds.length,
      failed: errors.length,
      errors,
    };
  },

  // Nothing to build afterwards: an update writes into columns that already
  // exist, so there is no index to reconcile and no file to close.
  finalize: () => Promise.resolve(),

  buildApprovalPayload: async (
    op,
  ): Promise<ToolApprovalRecordImportPayload> => {
    const collection = await db.query.collections.findFirst({
      columns: { label: true, icon: true, color: true },
      where: { id: op.params.collectionId },
    });
    const updates = op.sample.flatMap((item) => readUpdateRow(item) ?? []);
    // The sample is three rows, so reading their current values is cheap — and
    // it is what turns the card from "80 000 rows will change" into a
    // before→after a reviewer can actually judge.
    const snapshots = await getRecordSnapshots({
      teamId: op.teamId,
      ids: updates.map((u) => u.id),
    });
    return {
      op: "update",
      operationId: op.id,
      totalRows: op.totalItems,
      merge: mergeOf(op),
      collectionKey: op.params.collectionKey,
      collectionId: op.params.collectionId,
      ...(collection?.label ? { typeName: collection.label } : {}),
      ...(collection?.icon ? { typeIcon: collection.icon } : {}),
      ...(collection?.color ? { typeColor: collection.color } : {}),
      ...(op.columns ? { columns: op.columns } : {}),
      items: updates.map((update) => {
        const snapshot = snapshots.get(update.id);
        return {
          recordId: update.id,
          data: update.data,
          collectionId: op.params.collectionId,
          collectionKey: op.params.collectionKey,
          ...(snapshot ? { currentLabel: snapshot.label } : {}),
          ...(snapshot ? { currentData: snapshot.data } : {}),
        };
      }),
    };
  },

  describe: (op) =>
    `Updating ${op.totalItems.toString()} records in ${op.params.collectionKey}`,
};
