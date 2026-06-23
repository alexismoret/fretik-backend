import db, { type Transaction } from "../../db";
import { domainEventLinks } from "../../db/schema";

/**
 * One event↔record provenance edge. `role` is free text — subject | mentioned |
 * created | affected — describing how the event touched the record.
 */
export interface EventRecordLink {
  recordId: string;
  role?: string;
}

/**
 * Write the event↔record provenance edges for a journal entry — the
 * memory-recall + attribute-history hot path ("what happened to this record").
 * Idempotent on the `(event, record, role)` unique index. Runs inside the
 * emitting transaction when `tx` is supplied.
 */
export const linkEventToRecords = async (input: {
  tx?: Transaction;
  eventId: string;
  links: EventRecordLink[];
}): Promise<void> => {
  if (input.links.length === 0) return;
  const exec = input.tx ?? db;
  await exec
    .insert(domainEventLinks)
    .values(
      input.links.map((l) => ({
        eventId: input.eventId,
        recordId: l.recordId,
        role: l.role ?? "mentioned",
      })),
    )
    .onConflictDoNothing({
      target: [
        domainEventLinks.eventId,
        domainEventLinks.recordId,
        domainEventLinks.role,
      ],
    });
};
