import db from "../../../db";
import type {
  BulkOperation,
  ToolApprovalRecordImportPayload,
} from "../../../db/schema";
import { bulkCreateCollectionRecords } from "../../collection-records/bulk-create";
import { reconcileFieldIndexes } from "../../collection-schema/reconcile-indexes";
import type { EventActor } from "../../domain-events/emit";
import { importAgentKey } from "../agent-key";
import type { BulkOperationExecutor, ChunkOutcome } from "../types";

/**
 * `record_import` — many new records of ONE collection, uploaded in chunks.
 *
 * Every row still goes through `bulkCreateCollectionRecords`, so field validation,
 * the typed extension table, relations and the `record.created` journal are
 * exactly what a small `bulk_create` produces. What changes at this size is
 * only WHEN the work happens, never WHAT it does.
 *
 * Two deliberate differences from a small write:
 *  - `skipIndexReconcile` on every chunk, then ONE reconcile in `finalize`.
 *    Per-chunk reconciles would fire a hundred `CREATE INDEX CONCURRENTLY`
 *    passes at the same table while the load is still running.
 *  - `agentKey: "import:<id>"` on the journal entries, so the workflow trigger
 *    sweep skips them. Loading history is not a business event stream: without
 *    it, importing 200 000 clients into a team that runs "when a client is
 *    created, send a welcome email" sends 200 000 emails.
 */

const actorFor = (op: BulkOperation): EventActor => ({
  // Same attribution as the direct objects-SDK path (`execActor`), so an
  // imported record's provenance reads like any other agent-driven write.
  actorType: "connector",
  actorUserId: op.userId,
  conversationId: op.conversationId,
  agentKey: importAgentKey(op.id),
});

const rowsOf = (
  items: Record<string, unknown>[],
): { data: Record<string, unknown> }[] => items.map((data) => ({ data }));

export const recordImportExecutor: BulkOperationExecutor = {
  kind: "record_import",

  validateSample: async (op) => {
    const { errors } = await bulkCreateCollectionRecords({
      organizationId: op.organizationId,
      teamId: op.teamId,
      userId: op.userId,
      collectionId: op.params.collectionId,
      rows: rowsOf(op.sample),
      dryRun: true,
    });
    return errors;
  },

  applyChunk: async ({ op, items }): Promise<ChunkOutcome> => {
    const result = await bulkCreateCollectionRecords({
      organizationId: op.organizationId,
      teamId: op.teamId,
      userId: op.userId,
      collectionId: op.params.collectionId,
      rows: rowsOf(items),
      // One reconcile for the whole load, in `finalize`.
      skipIndexReconcile: true,
      actor: actorFor(op),
    });
    return {
      succeeded: result.ids.filter((id) => id !== null).length,
      failed: result.errors.length,
      errors: result.errors,
      ids: result.ids,
    };
  },

  // The moment to build the type's field indexes: once, after the whole load.
  // The runner fires this WITHOUT waiting, for the same reason
  // `bulkCreateCollectionRecords` does not wait for its own — `CREATE INDEX
  // CONCURRENTLY` scales with the table and the rows are readable without it.
  finalize: async (op) => {
    await reconcileFieldIndexes({ collectionId: op.params.collectionId });
  },

  buildApprovalPayload: async (
    op,
  ): Promise<ToolApprovalRecordImportPayload> => {
    // Display metadata only — the card names the target type, it does not
    // render its schema, so this stays a three-column read rather than
    // `getCollection`'s type + full field catalog.
    const type = await db.query.collections.findFirst({
      columns: { label: true, icon: true, color: true },
      where: { id: op.params.collectionId },
    });
    return {
      op: "create",
      operationId: op.id,
      totalRows: op.totalItems,
      collectionKey: op.params.collectionKey,
      collectionId: op.params.collectionId,
      ...(type?.label ? { typeName: type.label } : {}),
      ...(type?.icon ? { typeIcon: type.icon } : {}),
      ...(type?.color ? { typeColor: type.color } : {}),
      ...(op.columns ? { columns: op.columns } : {}),
      // The sample, rendered by the same field-by-field card a small write
      // uses — the reviewer checks the MAPPING here, not the rows.
      items: op.sample.map((data) => ({
        data,
        collectionId: op.params.collectionId,
        collectionKey: op.params.collectionKey,
      })),
    };
  },

  describe: (op) =>
    `Importing ${op.totalItems.toString()} records into ${op.params.collectionKey}`,
};
