import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { invalidateFieldDefinitionsCache } from "./cache";

/**
 * Apply a new display ordering across multiple definitions in a single
 * transaction. The frontend sends the full list of ids in their new order
 * after a drag-and-drop reorder; positions are assigned 0…n-1.
 *
 * Validates that every id belongs to the same scope (org or team) the
 * caller intends, by re-fetching the rows and rejecting mismatches.
 */
export const reorderFieldDefinitions = async (data: {
  organizationId: string;
  teamId: string | null;
  /** `ids` in the desired final order (index 0 = first). */
  ids: string[];
}): Promise<void> => {
  const { organizationId, teamId, ids } = data;

  if (ids.length === 0) return;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: fieldDefinitions.id,
        organizationId: fieldDefinitions.organizationId,
        teamId: fieldDefinitions.teamId,
      })
      .from(fieldDefinitions)
      .where(inArray(fieldDefinitions.id, ids));

    if (rows.length !== ids.length) {
      return throwHttpError(
        400,
        badRequest("One or more field definitions not found"),
      );
    }
    const scopeMismatch = rows.some(
      (r) => r.organizationId !== organizationId || r.teamId !== teamId,
    );
    if (scopeMismatch) {
      return throwHttpError(
        400,
        badRequest("All field definitions must belong to the same scope"),
      );
    }

    for (let index = 0; index < ids.length; index += 1) {
      await tx
        .update(fieldDefinitions)
        .set({ displayOrder: index })
        .where(eq(fieldDefinitions.id, ids[index]!));
    }
  });

  await invalidateFieldDefinitionsCache({ organizationId, teamId });
};
