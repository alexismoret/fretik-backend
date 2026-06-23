import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

/**
 * Delete an object record and journal `record.deleted` in the same transaction.
 * The FK cascade removes its links (both directions) and the event-link
 * provenance rows, so the event keeps the id + label in its PAYLOAD (its
 * `subjectRecordId` is nulled by the cascade) — the deletion stays auditable
 * after the row is gone.
 */
export const deleteObjectRecord = async (data: {
  id: string;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<{ id: string }> => {
  const actor = data.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<{ id: string }> => {
    const existing = await tx.query.objectRecords.findFirst({
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

    await tx.delete(objectRecords).where(eq(objectRecords.id, data.id));
    return { id: data.id };
  };

  return data.tx ? run(data.tx) : db.transaction(run);
};
