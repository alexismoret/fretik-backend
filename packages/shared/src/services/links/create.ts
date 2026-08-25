import db, { type Executor, type Transaction } from "../../db";
import type { Link, OntologySource } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import type { EventActor } from "../domain-events/emit";
import { bulkCreateLinks } from "./bulk-create";

/**
 * Create a typed edge between two records — the single-edge front to the
 * set-based `bulkCreateLinks`, so there is ONE link-write + journal path. Both
 * ends are validated against the link type (`fromRecord` type =
 * `linkType.fromCollectionId`; `toRecord` type = `linkType.toCollectionId`
 * unless polymorphic/null). Idempotent on the active-edge unique index: at most
 * one active edge of a type between two records — on conflict it returns the
 * existing active edge and emits nothing. Pass `tx` to enlist in a caller's
 * transaction (the end-record reads then see rows created earlier in it).
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
  const { ids, errors } = await bulkCreateLinks({
    organizationId: input.organizationId,
    teamId: input.teamId,
    links: [
      {
        linkTypeId: input.linkTypeId,
        fromRecordId: input.fromRecordId,
        toRecordId: input.toRecordId,
        props: input.props,
        confidence: input.confidence,
      },
    ],
    source: input.source,
    actor: input.actor,
    tx: input.tx,
  });
  if (errors.length > 0) {
    return throwHttpError(400, badRequest(errors[0]?.error));
  }

  const exec: Executor = input.tx ?? db;
  const insertedId = ids[0];
  const edge = insertedId
    ? await exec.query.links.findFirst({ where: { id: insertedId } })
    : // Conflict (idempotent): the active edge already exists — return it.
      await exec.query.links.findFirst({
        where: {
          linkTypeId: input.linkTypeId,
          fromRecordId: input.fromRecordId,
          toRecordId: input.toRecordId,
          validTo: { isNull: true },
          invalidatedAt: { isNull: true },
        },
      });
  if (!edge) return throwHttpError(404, notFound("Link not found"));
  return edge;
};
