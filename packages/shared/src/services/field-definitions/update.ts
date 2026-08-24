import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { countNonNullColumnValues } from "../object-records/field-data";
import { refreshObjectTableAfterCatalogChange } from "../object-schema/catalog-sync";
import {
  changeFieldColumns,
  rebuildFormulaColumn,
  renameFieldColumns,
} from "../object-schema/table";
import { isDocumentObjectType } from "../object-types/is-document-type";
import { invalidateFieldDefinitionsCache } from "./cache";
import {
  assertNoFormulaDependents,
  formulaExpressionOf,
  formulasToRebuildAfter,
  readFormulaSiblings,
  resolveFormulaConfig,
} from "./formula-config";
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
  actor?: EventActor;
}): Promise<FieldDefinition> => {
  const { id, cascade = false } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;
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
    const effectiveConfig = patch.config ?? existing.config;

    // Siblings are read once here and reused: the formula compiler needs them,
    // and so do the dependency guards below.
    const siblings =
      (patch.type ?? existing.type) === "formula" || keyChanged || typeChanged
        ? await readFormulaSiblings({
            exec: tx,
            objectTypeId: existing.objectTypeId,
            teamId: existing.teamId,
            excludeFieldId: existing.id,
          })
        : [];

    // Renaming or retyping a field that a formula READS is refused by name.
    // Postgres would not stop either one: a rename silently rewrites the
    // generated expression while the stored formula text keeps naming the old
    // key, and a retype leaves an expression that no longer type-checks — both
    // fail much later, far from the change that caused them.
    if (keyChanged || typeChanged) {
      assertNoFormulaDependents({
        key: existing.key,
        label: existing.label,
        fields: [...siblings, existing],
        action: keyChanged ? "rename" : "change the type of",
      });
    }

    // Compile the formula (and infer its result type) before anything is
    // written, so an unusable expression never becomes a stored definition.
    if ((patch.type ?? existing.type) === "formula") {
      patch = {
        ...patch,
        config: resolveFormulaConfig({
          config: effectiveConfig,
          siblings,
          label: patch.label ?? existing.label,
        }),
      };
    }

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

    // The document type's title is locked to its `name` field — neither promote
    // another field nor demote `name`. Drop any isTitle change there.
    const isDocument = await isDocumentObjectType({
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      objectTypeId: existing.objectTypeId,
    });
    if (isDocument && patch.isTitle !== undefined) {
      patch = { ...patch, isTitle: undefined };
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
          siblings: [...siblings, updatedRow],
        });
      } else if (keyChanged) {
        await renameFieldColumns({
          tx,
          objectTypeId: updatedRow.objectTypeId,
          oldField: existing,
          newKey: updatedRow.key,
        });
      } else if (
        updatedRow.type === "formula" &&
        formulaExpressionOf(existing.config) !==
          formulaExpressionOf(updatedRow.config)
      ) {
        // Editing a formula is invisible to every idempotent path: the column
        // name did not change, so `reconcileObjectTable` sees nothing to do and
        // `ADD COLUMN IF NOT EXISTS` finds it already there. Without this the
        // edit would appear to succeed while every row kept its old value —
        // plausible numbers that are simply no longer what the formula says.
        //
        // Formulas that READ this one are rebuilt with it, and in order: each
        // holds an inlined COPY of the old SQL, so leaving them alone produces
        // the same silent staleness one level up.
        const scope = [...siblings, updatedRow];
        for (const field of [
          updatedRow,
          ...formulasToRebuildAfter({ key: updatedRow.key, fields: scope }),
        ]) {
          await rebuildFormulaColumn({
            tx,
            objectTypeId: updatedRow.objectTypeId,
            field,
            siblings: scope,
          });
        }
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

    // Journal the catalog change. Org-scope templates (teamId null) are outside
    // the team-scoped journal — skipped.
    if (updatedRow.teamId) {
      await emitDomainEvent({
        tx,
        organizationId: updatedRow.organizationId,
        teamId: updatedRow.teamId,
        type: "field.updated",
        actor,
        subjectType: "field",
        payload: {
          fieldDefinitionId: updatedRow.id,
          objectTypeId: updatedRow.objectTypeId,
          key: updatedRow.key,
          changed: Object.keys(patch).filter(
            (k) => patch[k as keyof typeof patch] !== undefined,
          ),
        },
      });
    }

    return updatedRow;
  });

  await invalidateFieldDefinitionsCache({
    organizationId: updated.organizationId,
    teamId: updated.teamId,
  });
  return updated;
};
