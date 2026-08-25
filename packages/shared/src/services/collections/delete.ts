import { eq } from "drizzle-orm";
import db from "../../db";
import { collections } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { purgeCardVectorsForType } from "../collection-records/card-indexing-policy";
import { dropCollectionTable } from "../collection-schema/table";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { DOCUMENT_COLLECTION_KEY } from "./constants";
import { invalidateCollectionIdCache } from "./resolve";

/**
 * Delete a collection. The `document` type is refused — it anchors the
 * uploaded-file record mirror and every document field definition, so the
 * upload pipeline depends on it. Every other type (including the seeded
 * company/person/note/task) is deletable; the FK cascade removes its records,
 * field definitions, and link types.
 *
 * The cascade is also why this has to purge the type's semantic cards itself.
 * Every other way a record disappears journals `record.deleted`, which the
 * sweep turns into a card deletion — a cascade journals nothing, so the cards
 * would outlive the records forever. Left alone they are not merely stale: they
 * keep competing in every semantic search, and they let the assistant retrieve
 * data the user deleted. Measured on a development database before this fix,
 * one deleted type had left 14 545 orphan cards against 33 document chunks.
 */
export const deleteCollection = async (data: {
  id: string;
  actor?: EventActor;
}): Promise<{ id: string }> => {
  const { id } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  const existing = await db.query.collections.findFirst({
    columns: { id: true, key: true, teamId: true, organizationId: true },
    where: { id },
  });
  if (!existing) {
    return throwHttpError(404, notFound("Collection not found"));
  }
  if (existing.key === DOCUMENT_COLLECTION_KEY) {
    return throwHttpError(
      400,
      badRequest(
        "The document collection cannot be deleted: it anchors uploaded files and their field definitions.",
      ),
    );
  }

  // Delete the row and drop its extension table in ONE tx — atomic, cheap
  // (metadata-only). One physical table per type id, so this is unconditional.
  await db.transaction(async (tx) => {
    // Journal first (org/system types — teamId null — are outside the
    // team-scoped journal). The type row is gone after this tx; the payload
    // keeps id + key so the deletion stays auditable.
    if (existing.teamId) {
      await emitDomainEvent({
        tx,
        organizationId: existing.organizationId,
        teamId: existing.teamId,
        type: "collection.deleted",
        actor,
        subjectType: "collection",
        payload: { collectionId: id, key: existing.key },
        dedupKey: `collection.deleted:${id}`,
      });
    }
    // In the SAME transaction as the cascade: a rollback must leave the index
    // describing the type that survived, not a type stripped of its cards.
    await purgeCardVectorsForType({ collectionId: id, tx });
    await tx.delete(collections).where(eq(collections.id, id));
    await dropCollectionTable({ tx, collectionId: id });
  });

  // Bust the key→id cache — otherwise `resolveCollectionId` keeps handing out
  // this now-dead id (up to the 30-min TTL), and the next resolve→operate call
  // 404s on a type that no longer exists.
  await invalidateCollectionIdCache({
    organizationId: existing.organizationId,
    teamId: existing.teamId,
    key: existing.key,
  });
  return { id };
};
