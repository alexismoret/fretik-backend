import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { DomainEventActor } from "../../db/schema";
import { domainEventLinks, domainEvents, user } from "../../db/schema";
import { idCursor } from "../../lib/cursor";

/**
 * Hard ceiling on one history page. A hot record touched thousands of times
 * must never fold its whole journal into app memory in one call.
 */
const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_MAX_LIMIT = 500;

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
 * Reads the record's latest events (via `domain_event_links`), bounded by
 * `limit` with uuid-v7 cursor pagination (`cursor` = an event id from a prior
 * page; ids are time-ordered), then replays each event's `payload.diff`
 * (`{ field: { from, to } }`, written by the record create/update outbox)
 * oldest-first into a per-field timeline. Events without a diff (e.g.
 * `document.uploaded`, `link.created`) still appear in `events` for the
 * activity view but contribute no field changes. `nextCursor` is non-null when
 * older events remain — a paged fold only covers the fetched window.
 */
export const getRecordHistory = async (data: {
  recordId: string;
  limit?: number;
  /** An event id from a previous `nextCursor` — the page starts just before
   *  it. Same opaque-string contract as every other cursor in the API; here
   *  the opaque value happens to be the id itself. */
  cursor?: string;
}): Promise<{
  recordId: string;
  fields: Record<string, FieldChange[]>;
  events: HistoryEvent[];
  nextCursor: string | null;
}> => {
  const limit = Math.min(
    data.limit ?? HISTORY_DEFAULT_LIMIT,
    HISTORY_MAX_LIMIT,
  );
  // A cursor that is not an id restarts the walk. It would otherwise reach a
  // `uuid` comparison and come back as a 500.
  const cursor = idCursor(data.cursor);
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
    .where(
      and(
        eq(domainEventLinks.recordId, data.recordId),
        ...(cursor ? [lt(domainEvents.id, cursor)] : []),
      ),
    )
    // Newest-first + one extra row to detect a further page; folded oldest-first
    // below (uuid v7 ids order like occurred_at).
    .orderBy(desc(domainEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();

  const fields: Record<string, FieldChange[]> = {};
  const events: HistoryEvent[] = [];
  const seen = new Set<string>();

  for (const row of page) {
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

  return {
    recordId: data.recordId,
    fields,
    events,
    // Oldest id of this page = the `before` cursor of the next (older) one.
    nextCursor: hasMore ? (page[0]?.id ?? null) : null,
  };
};
