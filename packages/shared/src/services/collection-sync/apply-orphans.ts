import { sql } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncOrphanPolicy } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { bulkDeleteCollectionRecords } from "../collection-records/bulk-delete";
import type { EventActor } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { upsertRecordSyncState } from "./record-state";

/**
 * What becomes of a record whose upstream row is gone.
 *
 * The default is `keep`, and deliberately not what Airtable and Coda do. An
 * upstream row can disappear for reasons that have nothing to do with the
 * thing it described: a filter narrowed, a date window rolled, an API paged
 * badly, a permission changed. Our records can also carry LOCAL columns, links
 * and approvals the app never knew about. Destroying those on an absence is
 * unrecoverable, and "it came back next run" is the normal case.
 *
 * So `keep` marks and does nothing else, `reject` moves the row out of the
 * default views while keeping it in the journal, and `delete` is the opt-in
 * one.
 */
export const applyOrphanPolicy = async (input: {
  organizationId: string;
  teamId: string;
  syncSourceId: string;
  policy: CollectionSyncOrphanPolicy;
  recordIds: readonly string[];
  actor: EventActor;
}): Promise<number> => {
  const ids = [...new Set(input.recordIds)];
  if (ids.length === 0) return 0;

  if (input.policy === "delete") {
    const { deletedIds } = await bulkDeleteCollectionRecords({
      teamId: input.teamId,
      ids,
      actor: input.actor,
    });
    // `record_sync_state` cascades with the record — nothing to write back.
    return deletedIds.length;
  }

  if (input.policy === "reject") {
    // NOT `setRecordStatus` in a loop: that service is single-row by contract
    // and a 5 000-row filter change would be 5 000 transactions. The two things
    // it does that matter here are done set-based instead — the status flip and
    // the `record.rejected` journal entry, which is what tells the card sweep
    // to drop the row's vector.
    for (const chunk of chunkForBulk(ids)) {
      await db.transaction(async (tx) => {
        await emitDomainEventsBulk({
          tx,
          organizationId: input.organizationId,
          teamId: input.teamId,
          actor: input.actor,
          events: chunk.map((recordId) => ({
            type: "record.rejected",
            subjectRecordId: recordId,
            payload: { reason: "upstream_row_missing" },
            recordLinks: [{ recordId, role: "subject" }],
          })),
        });
        await tx.execute(sql`
          UPDATE collection_records
             SET status = 'rejected'::ontology_status,
                 updated_by_actor = ${input.actor.actorType}::domain_event_actor,
                 updated_at = now()
           WHERE id = ANY(${sql.param(chunk)}::uuid[])
             AND sync_source_id = ${input.syncSourceId}::uuid
             AND status <> 'rejected'::ontology_status`);
      });
    }
  }

  // `keep` and `reject` both leave the row addressable, so both record WHY it
  // stopped being refreshed. `missing` is not an error and must not be retried
  // until the row comes back — the next run's diff is what clears it.
  await upsertRecordSyncState(
    input.syncSourceId,
    ids.map((recordId) => ({
      recordId,
      status: "missing" as const,
      error: null,
    })),
  );
  return ids.length;
};
