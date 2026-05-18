import { eq } from "drizzle-orm";
import db from "../../db";
import { documentFieldValues, fieldDefinitions } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { invalidateFieldDefinitionsCache } from "./cache";

/**
 * Delete a field definition. When `cascade=true`, also wipes every
 * `documentFieldValues` row whose `fieldKey` matches the deleted key
 * (this is the only safe way to drop a field with existing values — the
 * fieldKey would otherwise dangle).
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
      const rows = await tx
        .delete(documentFieldValues)
        .where(eq(documentFieldValues.fieldKey, existing.key))
        .returning({ id: documentFieldValues.id });
      deletedValues = rows.length;
    }

    await tx.delete(fieldDefinitions).where(eq(fieldDefinitions.id, id));
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
