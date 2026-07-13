import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { Link } from "../../db/schema";
import { links } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

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
