import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { countNonNullColumnValues } from "../object-records/field-data";
import { refreshObjectTableAfterCatalogChange } from "../object-schema/catalog-sync";
import { changeFieldColumns, renameFieldColumns } from "../object-schema/table";
import { invalidateFieldDefinitionsCache } from "./cache";
import { fillOptionColors } from "./normalize-config";
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
  const { id, cascade = false } = data;
  let patch = data.patch;

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

    // Server owns option colors — fill any the writer left unset on a config patch.
    if (patch.config !== undefined) {
      patch = {
        ...patch,
        config: fillOptionColors(patch.type ?? existing.type, patch.config),
      };
    }

    const keyChanged = patch.key !== undefined && patch.key !== existing.key;
    const typeChanged =
      patch.type !== undefined && patch.type !== existing.type;

    // Converting to/from `relation` changes storage (data ↔ links) and link-type
    // binding — recreate the field instead. (Editing a relation field's target
    // in place is a Phase-2 concern.)
    if (
      typeChanged &&
      (patch.type === "relation" || existing.type === "relation")
    ) {
      return throwHttpError(
        400,
        badRequest(
          "Changing a field's type to or from `relation` is not supported; delete and recreate the field.",
        ),
      );
    }

    if (keyChanged || typeChanged) {
      const hasValues =
        (await countNonNullColumnValues({
          tx,
          objectTypeId: existing.objectTypeId,
          field: existing,
        })) > 0;

      if (keyChanged && hasValues) {
        return throwHttpError(
          400,
          badRequest(
            "Renaming the field key is not allowed while values exist for this field. Use the rename operation instead.",
          ),
        );
      }
      if (typeChanged && hasValues && !cascade) {
        return throwHttpError(
          400,
          badRequest(
            "Changing the field type is not allowed while values exist. Pass cascade=true to drop existing values.",
          ),
        );
      }
    }

    // Only a text field can be the title. Ignore a promotion of any other type.
    const effectiveType = patch.type ?? existing.type;
    if (patch.isTitle === true && effectiveType !== "text") {
      patch = { ...patch, isTitle: undefined };
    }

    // Title moves: promoting this field demotes the type's current title (the
    // one-per-type unique index would otherwise reject the write). A type
    // always keeps a title, so demoting the current title via this path is a
    // no-op (use "promote another field" instead).
    if (patch.isTitle === true && !existing.isTitle) {
      await tx
        .update(fieldDefinitions)
        .set({ isTitle: false })
        .where(
          and(
            eq(fieldDefinitions.objectTypeId, existing.objectTypeId),
            existing.teamId === null
              ? isNull(fieldDefinitions.teamId)
              : eq(fieldDefinitions.teamId, existing.teamId),
            eq(fieldDefinitions.isTitle, true),
          ),
        );
    } else if (patch.isTitle === false && existing.isTitle) {
      // Refuse to leave a type with no title.
      patch = { ...patch, isTitle: undefined };
    }

    // Recompute enabled cap if we are turning a disabled field back on.
    const turningOn = patch.enabled === true && !existing.enabled;
    if (turningOn) {
      await assertScopeEnabledCap({
        organizationId: existing.organizationId,
        teamId: existing.teamId,
        objectTypeId: existing.objectTypeId,
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

    // Physical column change (team scope only — org templates have no table).
    // A type change recreates the column with the new type (resetting its
    // values); a pure key change renames the column (preserving its data).
    if (updatedRow.teamId) {
      if (typeChanged) {
        await changeFieldColumns({
          tx,
          objectTypeId: updatedRow.objectTypeId,
          oldField: existing,
          newField: updatedRow,
        });
      } else if (keyChanged) {
        await renameFieldColumns({
          tx,
          objectTypeId: updatedRow.objectTypeId,
          oldField: existing,
          newKey: updatedRow.key,
        });
      }
    }

    // Reconcile remaining columns + refresh search vectors, atomic with the
    // field-def change.
    await refreshObjectTableAfterCatalogChange({
      tx,
      organizationId: updatedRow.organizationId,
      objectTypeId: updatedRow.objectTypeId,
      teamId: updatedRow.teamId,
    });

    return updatedRow;
  });

  await invalidateFieldDefinitionsCache({
    organizationId: updated.organizationId,
    teamId: updated.teamId,
  });
  return updated;
};
