import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { collectionRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { hideEpisodesForRecords } from "../episodes/hide-for-source";
import { deleteEpisodeVectors } from "../episodes/vectors";

/**
 * Delete a record and journal `record.deleted` in the same transaction.
 * The FK cascade removes its links (both directions) and the event-link
 * provenance rows, so the event keeps the id + label in its PAYLOAD (its
 * `subjectRecordId` is nulled by the cascade) — the deletion stays auditable
 * after the row is gone.
 */
export const deleteCollectionRecord = async (data: {
  id: string;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<{ id: string }> => {
  const actor = data.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<{ id: string }> => {
    const existing = await tx.query.collectionRecords.findFirst({
      columns: { id: true, organizationId: true, teamId: true, label: true },
      where: { id: data.id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Record not found"));
    }

    await emitDomainEvent({
      tx,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      type: "record.deleted",
      actor,
      payload: { recordId: existing.id, label: existing.label },
    });

    // Hide the record-activity episode anchored on this record BEFORE the row
    // goes (the `anchorRecordId` FK nulls on delete). It leaves recall now and
    // the GC purges it after 30 days.
    const hiddenEpisodeIds = await hideEpisodesForRecords(tx, [data.id]);
    // Inside the tx, not after it: `ai_vectors` has no FK to episodes, so the
    // demotion and the vector drop have to commit together. Run outside, a
    // rollback would leave the episode `active` with its vectors already gone
    // on another connection — invisible to recall, with nothing to rebuild it.
    await deleteEpisodeVectors(hiddenEpisodeIds, tx);

    await tx.delete(collectionRecords).where(eq(collectionRecords.id, data.id));
    return { id: data.id };
  };

  return data.tx ? run(data.tx) : db.transaction(run);
};
