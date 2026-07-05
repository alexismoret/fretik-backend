import db, { type Transaction } from "../../db";
import type { OntologySource, OntologyStatus } from "../../db/schema";
import { domainEventLinks } from "../../db/schema";

/**
 * One event↔record provenance edge. `role` is free text — subject | mentioned |
 * created | affected — describing how the event touched the record. Trust
 * fields default to exact source-written links (confirmed/system, no
 * confidence); the async resolver passes its match band instead.
 */
export interface EventRecordLink {
  recordId: string;
  role?: string;
  confidence?: number | null;
  status?: OntologyStatus;
  source?: OntologySource;
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
        confidence: l.confidence != null ? String(l.confidence) : null,
        status: l.status ?? "confirmed",
        source: l.source ?? "system",
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
