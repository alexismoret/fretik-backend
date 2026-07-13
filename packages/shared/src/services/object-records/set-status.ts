import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { ObjectRecordWithData } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import {
  buildExtensionUpdate,
  readRecordData,
} from "../object-schema/record-io";

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
}): Promise<ObjectRecordWithData> => {
  const { id, status } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<ObjectRecordWithData> => {
    const existing = await tx.query.objectRecords.findFirst({
      columns: {
        id: true,
        organizationId: true,
        teamId: true,
        objectTypeId: true,
      },
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

    // Keep the extension table's denormalized `status` in sync.
    const ext = buildExtensionUpdate({
      objectTypeId: existing.objectTypeId,
      recordId: id,
      fields: [],
      data: {},
      status,
    });
    if (ext) await tx.execute(ext);

    const data = await readRecordData({
      tx,
      objectTypeId: existing.objectTypeId,
      recordId: id,
      fields: await getFieldDefinitionsForTeam({
        teamId: existing.teamId,
        objectTypeId: existing.objectTypeId,
      }),
    });
    return { ...row, data };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
