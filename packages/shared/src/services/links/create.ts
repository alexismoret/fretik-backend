import { and, eq, isNull } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { Link, OntologySource } from "../../db/schema";
import { links } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

/**
 * Create a typed edge between two records, journaling `link.created` in the same
 * transaction (the outbox guarantee). Both ends are validated against the link
 * type at write:
 *   - `fromRecord.objectTypeId` must equal `linkType.fromObjectTypeId`.
 *   - `toRecord.objectTypeId` must equal `linkType.toObjectTypeId`, unless the
 *     link type is polymorphic (`toObjectTypeId` null), in which case any type
 *     is allowed.
 *
 * Idempotent on the active-edge unique index (`onConflictDoNothing`): at most
 * one active edge of a type between two records. On conflict it returns the
 * existing active edge and emits nothing. Temporal link types record
 * `recordedAt = now`. Pass `tx` to enlist in a caller's transaction — the
 * end-record reads then see rows created earlier in that same transaction.
 */
export const createLink = async (input: {
  organizationId: string;
  teamId: string;
  linkTypeId: string;
  fromRecordId: string;
  toRecordId: string;
  props?: Record<string, unknown>;
  source?: OntologySource;
  confidence?: number | null;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<Link> => {
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<Link> => {
    // Sequential, NOT Promise.all: a transaction holds a single pg connection,
    // so concurrent queries on `tx` serialize on one client and trip pg's
    // "client is already executing a query" deprecation (a hard error in pg@9).
    const linkType = await tx.query.linkTypes.findFirst({
      columns: {
        id: true,
        fromObjectTypeId: true,
        toObjectTypeId: true,
        isTemporal: true,
      },
      where: { id: input.linkTypeId },
    });
    const fromRecord = await tx.query.objectRecords.findFirst({
      columns: { id: true, objectTypeId: true },
      where: { id: input.fromRecordId },
    });
    const toRecord = await tx.query.objectRecords.findFirst({
      columns: { id: true, objectTypeId: true },
      where: { id: input.toRecordId },
    });

    if (!linkType) {
      return throwHttpError(404, notFound("Link type not found"));
    }
    if (!fromRecord || !toRecord) {
      return throwHttpError(404, notFound("Record not found"));
    }
    if (fromRecord.objectTypeId !== linkType.fromObjectTypeId) {
      return throwHttpError(
        400,
        badRequest(
          "The source record's type does not match the link type's source object type.",
        ),
      );
    }
    if (
      linkType.toObjectTypeId !== null &&
      toRecord.objectTypeId !== linkType.toObjectTypeId
    ) {
      return throwHttpError(
        400,
        badRequest(
          "The target record's type does not match the link type's target object type.",
        ),
      );
    }

    const [inserted] = await tx
      .insert(links)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        linkTypeId: input.linkTypeId,
        fromRecordId: input.fromRecordId,
        toRecordId: input.toRecordId,
        props: input.props ?? {},
        source: input.source ?? "user_manual",
        confidence: input.confidence == null ? null : String(input.confidence),
        recordedAt: linkType.isTemporal ? new Date() : null,
      })
      .onConflictDoNothing({
        target: [links.linkTypeId, links.fromRecordId, links.toRecordId],
        where: and(isNull(links.validTo), isNull(links.invalidatedAt)),
      })
      .returning();

    if (inserted) {
      const event = await emitDomainEvent({
        tx,
        organizationId: input.organizationId,
        teamId: input.teamId,
        type: "link.created",
        actor,
        payload: {
          linkId: inserted.id,
          linkTypeId: input.linkTypeId,
          fromRecordId: input.fromRecordId,
          toRecordId: input.toRecordId,
        },
        recordLinks: [
          { recordId: input.fromRecordId, role: "affected" },
          { recordId: input.toRecordId, role: "affected" },
        ],
      });

      const [withProvenance] = await tx
        .update(links)
        .set({ sourceEventId: event.id })
        .where(eq(links.id, inserted.id))
        .returning();
      return withProvenance ?? inserted;
    }

    // Conflict: the active edge already exists — return it, emit nothing.
    const existing = await tx.query.links.findFirst({
      where: {
        linkTypeId: input.linkTypeId,
        fromRecordId: input.fromRecordId,
        toRecordId: input.toRecordId,
        validTo: { isNull: true },
        invalidatedAt: { isNull: true },
      },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Link not found"));
    }
    return existing;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
