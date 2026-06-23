import { eq } from "drizzle-orm";
import db from "../../db";
import { fieldDefinitions } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteFieldKeysFromRecords } from "../object-records/field-data";
import { refreshTypedViewAfterCatalogChange } from "../object-types/sync-typed-view";
import { invalidateFieldDefinitionsCache } from "./cache";

/**
 * Delete a field definition. When `cascade=true`, also strips the field key
 * from every record's `data` for that object type (this is the only safe way to
 * drop a field with existing values — the key would otherwise dangle in the
 * stored JSONB).
 *
 * `cascade=false` (default) protects against accidental data loss:
 * deletion fails if any value still references the key.
 *
 * Wrapped in a transaction so the def + its values are either both gone
 * or both still there. Cache invalidation fires after commit.
 */
export const deleteFieldDefinition = async (data: {
  id: string;
  cascade?: boolean;
}): Promise<{ id: string; deletedValues: number }> => {
  const { id, cascade = false } = data;

  const result = await db.transaction(async (tx) => {
    const existing = await tx.query.fieldDefinitions.findFirst({
      columns: {
        id: true,
        key: true,
        objectTypeId: true,
        organizationId: true,
        teamId: true,
      },
      where: { id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Field definition not found"));
    }

    let deletedValues = 0;
    if (cascade) {
      deletedValues = await deleteFieldKeysFromRecords({
        tx,
        objectTypeId: existing.objectTypeId,
        keys: [existing.key],
      });
    }

    await tx.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));

    // Regenerate the team's typed view (column dropped) + search vectors, in
    // the SAME tx so the catalog change is atomic.
    await refreshTypedViewAfterCatalogChange({
      tx,
      organizationId: existing.organizationId,
      objectTypeId: existing.objectTypeId,
      teamId: existing.teamId,
    });

    return {
      id,
      deletedValues,
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
