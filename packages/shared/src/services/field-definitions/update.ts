import { count, eq } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { documentFieldValues, fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { invalidateFieldDefinitionsCache } from "./cache";
import {
  assertScopeEnabledCap,
  type FieldDefinitionPatch,
  validateFieldDefinitionShape,
} from "./validate";

/**
 * Patch a single field definition.
 *
 * Invariants enforced beyond intrinsic validation:
 *   - `key` is immutable when values referencing the old key exist.
 *     The settings UI surfaces a "Rename" affordance that uses a separate
 *     code path (renames both the def and every `documentFieldValues.fieldKey`).
 *   - `type` is immutable when values exist (semantics would silently break).
 *     Use `cascade: true` to drop the existing values and proceed.
 *   - Toggling `enabled` from off → on re-runs the scope cap check.
 *
 * Whole operation runs in a single transaction so a type change with
 * cascade can never leave the def updated while the values are still
 * present (or vice-versa) if the second statement fails.
 */
export const updateFieldDefinition = async (data: {
  id: string;
  cascade?: boolean;
  patch: FieldDefinitionPatch;
}): Promise<FieldDefinition> => {
  const { id, cascade = false, patch } = data;

  const updated = await db.transaction(async (tx) => {
    const existing = await tx.query.fieldDefinitions.findFirst({
      where: { id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Field definition not found"));
    }

    validateFieldDefinitionShape({
      key: patch.key,
      label: patch.label,
      description: patch.description ?? null,
      type: patch.type ?? existing.type,
      config: patch.config ?? existing.config,
    });

    const keyChanged = patch.key !== undefined && patch.key !== existing.key;
    const typeChanged =
      patch.type !== undefined && patch.type !== existing.type;

    if (keyChanged || typeChanged) {
      const [valueCount] = await tx
        .select({ n: count() })
        .from(documentFieldValues)
        .where(eq(documentFieldValues.fieldKey, existing.key));
      const hasValues = (valueCount?.n ?? 0) > 0;

      if (keyChanged && hasValues) {
        return throwHttpError(
          400,
          badRequest(
            "Renaming the field key is not allowed while values exist for this field. Use the rename operation instead.",
          ),
        );
      }
      if (typeChanged && hasValues) {
        if (!cascade) {
          return throwHttpError(
            400,
            badRequest(
              "Changing the field type is not allowed while values exist. Pass cascade=true to drop existing values.",
            ),
          );
        }
        await tx
          .delete(documentFieldValues)
          .where(eq(documentFieldValues.fieldKey, existing.key));
      }
    }

    // Recompute enabled cap if we are turning a disabled field back on.
    const turningOn = patch.enabled === true && !existing.enabled;
    if (turningOn) {
      await assertScopeEnabledCap({
        organizationId: existing.organizationId,
        teamId: existing.teamId,
        resourceType: existing.resourceType,
        addEnabled: 1,
        excludeId: existing.id,
      });
    }

    const [updatedRow] = await tx
      .update(fieldDefinitions)
      .set({ ...patch })
      .where(eq(fieldDefinitions.id, id))
      .returning();
    if (!updatedRow) {
      return throwHttpError(404, notFound("Field definition not found"));
    }
    return updatedRow;
  });

  await invalidateFieldDefinitionsCache({
    organizationId: updated.organizationId,
    teamId: updated.teamId,
  });
  return updated;
};
