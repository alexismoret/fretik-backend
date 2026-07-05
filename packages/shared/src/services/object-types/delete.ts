import { eq } from "drizzle-orm";
import db from "../../db";
import { objectTypes } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { dropObjectTable } from "../object-schema/table";
import { DOCUMENT_TYPE_KEY } from "./constants";
import { invalidateObjectTypeIdCache } from "./resolve";

/**
 * Delete an object type. The `document` type is refused — it anchors the
 * uploaded-file record mirror and every document field definition, so the
 * upload pipeline depends on it. Every other type (including the seeded
 * company/person/note/task) is deletable; the FK cascade removes its records,
 * field definitions, and link types.
 */
export const deleteObjectType = async (data: {
  id: string;
  actor?: EventActor;
}): Promise<{ id: string }> => {
  const { id } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  const existing = await db.query.objectTypes.findFirst({
    columns: { id: true, key: true, teamId: true, organizationId: true },
    where: { id },
  });
  if (!existing) {
    return throwHttpError(404, notFound("Object type not found"));
  }
  if (existing.key === DOCUMENT_TYPE_KEY) {
    return throwHttpError(
      400,
      badRequest(
        "The document object type cannot be deleted: it anchors uploaded files and their field definitions.",
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
        type: "object_type.deleted",
        actor,
        subjectType: "object_type",
        payload: { objectTypeId: id, key: existing.key },
        dedupKey: `object_type.deleted:${id}`,
      });
    }
    await tx.delete(objectTypes).where(eq(objectTypes.id, id));
    await dropObjectTable({ tx, objectTypeId: id });
  });

  // Bust the key→id cache — otherwise `resolveObjectTypeId` keeps handing out
  // this now-dead id (up to the 30-min TTL), and the next resolve→operate call
  // 404s on a type that no longer exists.
  await invalidateObjectTypeIdCache({
    organizationId: existing.organizationId,
    teamId: existing.teamId,
    key: existing.key,
  });
  return { id };
};
