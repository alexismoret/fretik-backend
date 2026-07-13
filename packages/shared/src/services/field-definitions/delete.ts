import { eq } from "drizzle-orm";
import db from "../../db";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { countNonNullColumnValues } from "../object-records/field-data";
import { refreshObjectTableAfterCatalogChange } from "../object-schema/catalog-sync";
import { isDocumentObjectType } from "../object-types/is-document-type";
import { invalidateFieldDefinitionsCache } from "./cache";

/**
 * Delete a field definition. Dropping the field drops its real column (and the
 * stored values with it), so `cascade=false` (default) refuses the delete when
 * any record still carries a value for the field. `cascade=true` proceeds and
 * the column — with its data — is dropped by the table reconcile.
 *
 * Wrapped in a transaction so the def removal and the column drop are atomic.
 * Cache invalidation fires after commit.
 */
export const deleteFieldDefinition = async (data: {
  id: string;
  cascade?: boolean;
  actor?: EventActor;
}): Promise<{ id: string; deletedValues: number }> => {
  const { id, cascade = false } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  const result = await db.transaction(async (tx) => {
    const existing = await tx.query.fieldDefinitions.findFirst({
      where: { id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Field definition not found"));
    }

    // The document type's `name` title anchors every record's display name and
    // cannot be dropped — it must always keep exactly one title.
    if (
      existing.isTitle &&
      (await isDocumentObjectType({
        organizationId: existing.organizationId,
        teamId: existing.teamId,
        objectTypeId: existing.objectTypeId,
      }))
    ) {
      return throwHttpError(
        400,
        badRequest(
          "The document name field is the locked title; it cannot be deleted.",
        ),
      );
    }

    const valueCount = await countNonNullColumnValues({
      tx,
      objectTypeId: existing.objectTypeId,
      field: existing,
    });
    if (valueCount > 0 && !cascade) {
      return throwHttpError(
        400,
        badRequest(
          `Cannot delete field '${existing.key}' while ${valueCount} record(s) carry a value (pass cascade=true to drop them).`,
        ),
      );
    }

    // Journal first (org-scope templates — teamId null — are outside the
    // team-scoped journal). The def row is gone after this tx; the payload
    // keeps id + key so the deletion stays auditable.
    if (existing.teamId) {
      await emitDomainEvent({
        tx,
        organizationId: existing.organizationId,
        teamId: existing.teamId,
        type: "field.deleted",
        actor,
        subjectType: "field",
        payload: {
          fieldDefinitionId: id,
          objectTypeId: existing.objectTypeId,
          key: existing.key,
        },
        dedupKey: `field.deleted:${id}`,
      });
    }

    await tx.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));

    // Reconcile drops the now-orphaned column (+ refresh search vectors), in the
    // SAME tx so the catalog change is atomic.
    await refreshObjectTableAfterCatalogChange({
      tx,
      organizationId: existing.organizationId,
      objectTypeId: existing.objectTypeId,
      teamId: existing.teamId,
    });

    return {
      id,
      deletedValues: valueCount,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
    };
  });

  await invalidateFieldDefinitionsCache({
    organizationId: result.organizationId,
    teamId: result.teamId,
  });
  return { id: result.id, deletedValues: result.deletedValues };
};
