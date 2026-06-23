import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { ObjectRecord } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

/**
 * Flip a record's trust status — the human curating an AI-fed suggestion.
 * `confirmed` accepts the record into the team's data; `rejected` retires it.
 * Journals `record.confirmed` / `record.rejected` in the same transaction so
 * the decision is durable and feeds attribute-history + memory recall.
 */
export const setRecordStatus = async (input: {
  id: string;
  status: "confirmed" | "rejected";
  tx?: Transaction;
  actor?: EventActor;
}): Promise<ObjectRecord> => {
  const { id, status } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<ObjectRecord> => {
    const existing = await tx.query.objectRecords.findFirst({
      columns: { id: true, organizationId: true, teamId: true },
      where: { id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Record not found"));
    }

    const event = await emitDomainEvent({
      tx,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      type: status === "confirmed" ? "record.confirmed" : "record.rejected",
      actor,
      subjectRecordId: id,
      recordLinks: [{ recordId: id, role: "subject" }],
    });

    const [row] = await tx
      .update(objectRecords)
      .set({ status, sourceEventId: event.id })
      .where(eq(objectRecords.id, id))
      .returning();
    if (!row) {
      return throwHttpError(404, notFound("Record not found"));
    }
    return row;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
