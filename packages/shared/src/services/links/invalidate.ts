import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { Link } from "../../db/schema";
import { links } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";

/**
 * Non-destructively invalidate an edge: set `invalidatedAt = now` and, when a
 * superseding edge is supplied, `invalidatedByLinkId`. The row stays for
 * history; the active-edge unique index frees up so a replacement can be
 * inserted. Journals `link.invalidated` in the same transaction (the outbox
 * guarantee).
 */
export const invalidateLink = async (data: {
  id: string;
  replacedByLinkId?: string | null;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<Link> => {
  const actor = data.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<Link> => {
    const [row] = await tx
      .update(links)
      .set({
        invalidatedAt: new Date(),
        invalidatedByLinkId: data.replacedByLinkId ?? null,
      })
      .where(eq(links.id, data.id))
      .returning();
    if (!row) {
      return throwHttpError(404, notFound("Link not found"));
    }

    const event = await emitDomainEvent({
      tx,
      organizationId: row.organizationId,
      teamId: row.teamId,
      type: "link.invalidated",
      actor,
      payload: {
        linkId: row.id,
        linkTypeId: row.linkTypeId,
        replacedByLinkId: data.replacedByLinkId ?? null,
      },
      recordLinks: [
        { recordId: row.fromRecordId, role: "affected" },
        { recordId: row.toRecordId, role: "affected" },
      ],
    });

    const [withProvenance] = await tx
      .update(links)
      .set({ sourceEventId: event.id })
      .where(eq(links.id, row.id))
      .returning();
    return withProvenance ?? row;
  };

  return data.tx ? run(data.tx) : db.transaction(run);
};

/**
 * The set-based sibling of `invalidateLink`, for many edges at once: one
 * UPDATE, one bulk journal emit per team, one provenance stamp, per chunk —
 * all in one transaction, so the journal never says an edge went that is
 * still there.
 *
 * Idempotent where the single form is not: an edge already invalidated is
 * left alone (no second `invalidatedAt`, no second journal entry) and simply
 * not returned. Unknown ids are not returned either; the caller compares.
 * Scoping is the caller's job, as for `invalidateLink`.
 */
export const invalidateLinks = async (data: {
  ids: readonly string[];
  actor?: EventActor;
}): Promise<Link[]> => {
  const ids = [...new Set(data.ids)];
  if (ids.length === 0) return [];
  const actor = data.actor ?? SYSTEM_ACTOR;

  return db.transaction(async (tx) => {
    const invalidated: Link[] = [];
    for (const chunk of chunkForBulk(ids)) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await tx
        .update(links)
        .set({ invalidatedAt: new Date(), invalidatedByLinkId: null })
        .where(and(inArray(links.id, chunk), isNull(links.invalidatedAt)))
        .returning();
      invalidated.push(...rows);
    }
    if (invalidated.length === 0) return [];

    // The bulk emit is one team per call; an organization's edges can span
    // several teams (a shared record).
    const byTeam = new Map<string, Link[]>();
    for (const row of invalidated) {
      byTeam.set(row.teamId, [...(byTeam.get(row.teamId) ?? []), row]);
    }
    for (const [teamId, rows] of byTeam) {
      const [first] = rows;
      if (!first) continue;
      // Sequential, NOT Promise.all: a transaction holds one pg connection.
      // eslint-disable-next-line no-await-in-loop
      const { ids: eventIds } = await emitDomainEventsBulk({
        tx,
        organizationId: first.organizationId,
        teamId,
        actor,
        events: rows.map((row) => ({
          type: "link.invalidated",
          payload: {
            linkId: row.id,
            linkTypeId: row.linkTypeId,
            replacedByLinkId: null,
          },
          recordLinks: [
            { recordId: row.fromRecordId, role: "affected" },
            { recordId: row.toRecordId, role: "affected" },
          ],
        })),
      });
      const provenance = rows.map(
        (row, i) => sql`(${row.id}::uuid, ${eventIds[i]}::uuid)`,
      );
      // eslint-disable-next-line no-await-in-loop
      await tx.execute(
        sql`UPDATE links AS l
            SET source_event_id = v.event_id
            FROM (VALUES ${sql.join(provenance, sql`, `)}) AS v(link_id, event_id)
            WHERE l.id = v.link_id`,
      );
      rows.forEach((row, i) => {
        const eventId = eventIds[i];
        if (eventId) row.sourceEventId = eventId;
      });
    }
    return invalidated;
  });
};
