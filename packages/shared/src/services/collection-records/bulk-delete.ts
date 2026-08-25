import { inArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { collectionRecords } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { hideEpisodesForRecords } from "../episodes/hide-for-source";
import { deleteEpisodeVectors } from "../episodes/vectors";

/**
 * Result of a bulk delete. `deletedIds` are the records actually removed (owned
 * by the team and present); `errors` carries the ids that were skipped because
 * they are missing or belong to another team.
 */
export interface BulkDeleteResult {
  deletedIds: string[];
  errors: { id: string; error: string }[];
}

/**
 * Delete MANY records owned by `teamId` in a batch. The bulk sibling of
 * `deleteCollectionRecord`: same `record.deleted` journal entry per record, same FK
 * cascade (extension row, links, event-link provenance), but set-based — one
 * `INSERT` of the events and one `DELETE` per chunk, never a query per row.
 *
 * Tenancy is enforced HERE: only rows whose `owner_team_id` is `teamId` are
 * touched; any other id (other teams, made-up ids) is returned in `errors`. A
 * caller never needs a separate ownership pre-check.
 *
 * Pass `tx` to enlist in a caller's transaction (e.g. deleting a document deletes
 * its mirror in the same tx); omit it and each chunk gets its own transaction.
 */
export const bulkDeleteCollectionRecords = async (input: {
  teamId: string;
  ids: string[];
  actor?: EventActor;
  tx?: Transaction;
}): Promise<BulkDeleteResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const requestedIds = [...new Set(input.ids)];
  if (requestedIds.length === 0) return { deletedIds: [], errors: [] };

  const exec = input.tx ?? db;

  // Fetch the owned rows once (chunked SELECTs keep the IN-list bounded). The
  // event payload keeps id + label so the deletion stays auditable after the
  // row is gone (the cascade nulls `subject_record_id`).
  const owned: {
    id: string;
    organizationId: string;
    teamId: string;
    label: string;
  }[] = [];
  for (const idChunk of chunkForBulk(requestedIds)) {
    const rows = await exec
      .select({
        id: collectionRecords.id,
        organizationId: collectionRecords.organizationId,
        teamId: collectionRecords.teamId,
        label: collectionRecords.label,
      })
      .from(collectionRecords)
      .where(inArray(collectionRecords.id, idChunk));
    for (const r of rows) if (r.teamId === input.teamId) owned.push(r);
  }

  const ownedSet = new Set(owned.map((r) => r.id));
  const errors = requestedIds
    .filter((id) => !ownedSet.has(id))
    .map((id) => ({ id, error: "Record not found in your team." }));

  const deletedIds: string[] = [];
  const hiddenEpisodeIds: string[] = [];
  const runBatch = async (
    tx: Transaction,
    batch: typeof owned,
  ): Promise<void> => {
    // No recordLinks: the row is deleted below, a provenance edge would only
    // cascade away with it. Dedup-keyed — a record can be deleted once.
    await emitDomainEventsBulk({
      tx,
      organizationId: batch[0]!.organizationId,
      teamId: input.teamId,
      actor,
      events: batch.map((r) => ({
        type: "record.deleted",
        payload: { recordId: r.id, label: r.label },
        dedupKey: `record.deleted:${r.id}`,
      })),
    });
    // Hide record-activity episodes anchored on these records BEFORE the rows
    // go (the `anchorRecordId` FK nulls on delete). This is the common path —
    // deleting a document/folder bulk-deletes its mirror records through here.
    hiddenEpisodeIds.push(
      ...(await hideEpisodesForRecords(
        tx,
        batch.map((r) => r.id),
      )),
    );
    await tx.delete(collectionRecords).where(
      inArray(
        collectionRecords.id,
        batch.map((r) => r.id),
      ),
    );
  };
  for (const batch of chunkForBulk(owned)) {
    if (input.tx) await runBatch(input.tx, batch);
    else await db.transaction((tx) => runBatch(tx, batch));
    for (const r of batch) deletedIds.push(r.id);
  }

  // Drop the hidden episodes' recall vectors (no FK from `ai_vectors`).
  void deleteEpisodeVectors(hiddenEpisodeIds);

  return { deletedIds, errors };
};
