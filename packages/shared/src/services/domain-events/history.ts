import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { DomainEventActor } from "../../db/schema";
import { domainEventLinks, domainEvents, user } from "../../db/schema";

/**
 * The `payload.diff` shape written by the record create/update outbox:
 * `{ field: { from, to } }`. Parsed defensively (the column is untyped `jsonb`)
 * — a non-conforming payload folds to no field changes. `z.object` strips the
 * `from` key; only `to` (the new value) drives the timeline.
 */
const diffSchema = z.record(z.string(), z.object({ to: z.unknown() }));

interface FieldChange {
  value: unknown;
  at: Date;
  eventId: string;
  eventType: string;
}

interface HistoryEvent {
  id: string;
  type: string;
  occurredAt: Date;
  // `actorType` already encodes the origin (user / agent / system / connector);
  // the timeline derives the icon + label from it together with the event type.
  actorType: DomainEventActor;
  actorName: string | null;
  changedKeys: string[];
}

/**
 * Reconstruct a record's attribute history by FOLDING the durable journal. The
 * `object_records` row stores only the CURRENT value of each field; every prior
 * value is derived here — there is no record-level bi-temporal column.
 *
 * Reads every event that touched the record (via `domain_event_links`),
 * oldest-first, and replays each event's `payload.diff` (`{ field: { from, to }
 * }`, written by the record create/update outbox) into a per-field timeline.
 * Events without a diff (e.g. `document.uploaded`, `link.created`) still appear
 * in `events` for the activity view but contribute no field changes.
 */
export const getRecordHistory = async (data: {
  recordId: string;
}): Promise<{
  recordId: string;
  fields: Record<string, FieldChange[]>;
  events: HistoryEvent[];
}> => {
  const rows = await db
    .select({
      id: domainEvents.id,
      type: domainEvents.type,
      occurredAt: domainEvents.occurredAt,
      actorType: domainEvents.actorType,
      actorName: user.name,
      payload: domainEvents.payload,
    })
    .from(domainEventLinks)
    .innerJoin(domainEvents, eq(domainEventLinks.eventId, domainEvents.id))
    .leftJoin(user, eq(domainEvents.actorUserId, user.id))
    .where(eq(domainEventLinks.recordId, data.recordId))
    .orderBy(asc(domainEvents.occurredAt));

  const fields: Record<string, FieldChange[]> = {};
  const events: HistoryEvent[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    // A record can link to the same event in more than one role — fold once.
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const parsed = diffSchema.safeParse(row.payload.diff);
    const changedKeys = parsed.success ? Object.keys(parsed.data) : [];

    events.push({
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt,
      actorType: row.actorType,
      actorName: row.actorName ?? null,
      changedKeys,
    });

    if (!parsed.success) continue;
    for (const [key, change] of Object.entries(parsed.data)) {
      (fields[key] ??= []).push({
        value: change.to,
        at: row.occurredAt,
        eventId: row.id,
        eventType: row.type,
      });
    }
  }

  return { recordId: data.recordId, fields, events };
};
