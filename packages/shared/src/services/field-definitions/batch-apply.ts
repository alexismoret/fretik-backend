// oxlint-disable no-await-in-loop
import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import type { FieldDefinitionOperation } from "../../schemas/field-definitions";
import {
  countRecordsWithFieldKey,
  deleteFieldKeysFromRecords,
  renameFieldKeyInRecords,
} from "../object-records/field-data";
import { resolveOrgObjectTypeId } from "../object-types/resolve";
import { refreshTypedViewAfterCatalogChange } from "../object-types/sync-typed-view";
import { invalidateFieldDefinitionsCache } from "./cache";
import { slugifyFieldKey } from "./slugify-key";
import {
  assertScopeEnabledCap,
  validateFieldDefinitionShape,
} from "./validate";

/**
 * Apply a batch of operations atomically. The endpoint behind the AI
 * suggest modal hands the same shape that the LLM produced + the user
 * confirmed. Either every operation lands or none do — important because
 * the AI may have proposed a coherent set (e.g. "rename A → B then add C
 * that depends on B").
 *
 * The function runs inside a single DB transaction and re-validates each
 * operation (intrinsic shape + scope cap + key/type immutability) before
 * touching anything. The cap is computed at the end against the final
 * state to forbid creep.
 */
export const batchApplyFieldDefinitionOperations = async (data: {
  organizationId: string;
  teamId: string | null;
  operations: FieldDefinitionOperation[];
}): Promise<{
  created: number;
  updated: number;
  deleted: number;
  renamed: number;
}> => {
  const { organizationId, teamId, operations } = data;

  if (operations.length === 0) {
    return { created: 0, updated: 0, deleted: 0, renamed: 0 };
  }

  // Only document fields are supported today — resolve the system "document"
  // type once for the whole batch.
  const objectTypeId = await resolveOrgObjectTypeId({
    organizationId,
    key: "document",
  });

  const result = await db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let renamed = 0;

    for (const op of operations) {
      if (op.action === "create") {
        // The AI no longer generates the `key` — it was the most
        // common failure mode of the suggest call (DeepSeek would
        // occasionally emit prose, runaway whitespace, or a duplicate
        // of the description). We derive a stable snake_case key from
        // the label server-side and disambiguate collisions within
        // the scope by appending `_2`, `_3`, … so a second "Vessel
        // name" field becomes `vessel_name_2`.
        const baseKey = slugifyFieldKey(op.payload.label);
        const key = await pickAvailableKey({
          tx,
          organizationId,
          teamId,
          objectTypeId,
          baseKey,
        });
        validateFieldDefinitionShape({
          key,
          label: op.payload.label,
          description: op.payload.description ?? null,
          type: op.payload.type,
          config: op.payload.config,
        });
        await tx.insert(fieldDefinitions).values({
          organizationId,
          teamId,
          // The AI-suggest payload does not carry the object type — only
          // "document" is supported today, and keeping it out of the
          // schema spares the LLM one redundant field. Resolved above.
          objectTypeId,
          key,
          label: op.payload.label,
          description: op.payload.description ?? null,
          type: op.payload.type,
          config: op.payload.config,
          aiExtractionEnabled: op.payload.aiExtractionEnabled,
          vectorizeInclude: op.payload.vectorizeInclude,
          displayInPanel: op.payload.displayInPanel,
          displayInFilters: op.payload.displayInFilters,
          enabled: op.payload.enabled,
          displayOrder: op.payload.displayOrder,
        });
        created += 1;
      } else if (op.action === "update") {
        const existing = await assertOwnedById(
          tx,
          op.id,
          organizationId,
          teamId,
        );
        validateFieldDefinitionShape({
          key: op.patch.key,
          label: op.patch.label,
          description: op.patch.description ?? null,
          type: op.patch.type ?? existing.type,
          config: op.patch.config ?? existing.config,
        });
        // Key changes in batch are forbidden — use rename_key for that.
        if (op.patch.key !== undefined && op.patch.key !== existing.key) {
          return throwHttpError(
            400,
            badRequest(
              "Use `rename_key` to change a field's key; bare `update.patch.key` is not allowed in batches.",
            ),
          );
        }
        const typeChanged =
          op.patch.type !== undefined && op.patch.type !== existing.type;
        if (typeChanged) {
          const valueCount = await countRecordsWithFieldKey({
            tx,
            objectTypeId: existing.objectTypeId,
            key: existing.key,
          });
          if (valueCount > 0 && !op.patch.cascade) {
            return throwHttpError(
              400,
              badRequest(
                `Cannot change type of '${existing.key}' while values exist (use cascade=true).`,
              ),
            );
          }
          if (valueCount > 0 && op.patch.cascade) {
            await deleteFieldKeysFromRecords({
              tx,
              objectTypeId: existing.objectTypeId,
              keys: [existing.key],
            });
          }
        }
        await tx
          .update(fieldDefinitions)
          .set({ ...op.patch })
          .where(eq(fieldDefinitions.id, op.id));
        updated += 1;
      } else if (op.action === "delete") {
        const existing = await assertOwnedById(
          tx,
          op.id,
          organizationId,
          teamId,
        );
        if (op.cascade) {
          await deleteFieldKeysFromRecords({
            tx,
            objectTypeId: existing.objectTypeId,
            keys: [existing.key],
          });
        }
        await tx.delete(fieldDefinitions).where(eq(fieldDefinitions.id, op.id));
        deleted += 1;
      } else if (op.action === "rename_key") {
        const existing = await assertOwnedById(
          tx,
          op.id,
          organizationId,
          teamId,
        );
        if (existing.key === op.newKey) continue;
        // Migrate any record values stored under the old key before changing
        // the def, so the value carries over to the new key.
        await renameFieldKeyInRecords({
          tx,
          objectTypeId: existing.objectTypeId,
          fromKey: existing.key,
          toKey: op.newKey,
        });
        await tx
          .update(fieldDefinitions)
          .set({ key: op.newKey })
          .where(eq(fieldDefinitions.id, op.id));
        renamed += 1;
      }
    }

    // Final cap check against the post-batch state.
    await assertScopeEnabledCap({
      organizationId,
      teamId,
      objectTypeId,
      addEnabled: 0,
    });

    // One typed-view + search-vector refresh for the whole batch (every op
    // targets the same object type), atomic with the field-def changes.
    await refreshTypedViewAfterCatalogChange({
      tx,
      organizationId,
      objectTypeId,
      teamId,
    });

    return { created, updated, deleted, renamed };
  });

  await invalidateFieldDefinitionsCache({ organizationId, teamId });
  return result;
};

const assertOwnedById = async (
  tx: Transaction,
  id: string,
  organizationId: string,
  teamId: string | null,
): Promise<FieldDefinition> => {
  const row = await tx.query.fieldDefinitions.findFirst({
    where: { id },
  });
  if (!row) {
    return throwHttpError(404, notFound(`Field definition ${id} not found`));
  }
  if (row.organizationId !== organizationId || row.teamId !== teamId) {
    return throwHttpError(400, badRequest("Scope mismatch on operation"));
  }
  return row;
};

/**
 * Pick a key that doesn't collide with existing definitions in the
 * same scope. Tries `baseKey`, then `baseKey_2`, `baseKey_3`, … We
 * bail after 1 000 attempts (defensive — would mean a team has 1 000+
 * versions of the same label, which the scope cap prevents anyway).
 *
 * Uses the Drizzle v2 RQB filter-object syntax (consistent with the
 * other `tx.query` calls in this file) — `teamId: null` in this syntax
 * translates to `IS NULL`, so organisation-scoped templates still get
 * collision detection.
 */
const pickAvailableKey = async (data: {
  tx: Transaction;
  organizationId: string;
  teamId: string | null;
  objectTypeId: string;
  baseKey: string;
}): Promise<string> => {
  const { tx, organizationId, teamId, objectTypeId, baseKey } = data;

  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? baseKey : `${baseKey}_${i + 1}`.slice(0, 60);
    const collision = await tx.query.fieldDefinitions.findFirst({
      columns: { id: true },
      where: {
        organizationId,
        objectTypeId,
        key: candidate,
        // Drizzle v2 RQB requires `{ isNull: true }` to match NULL —
        // a bare `null` is rejected by the filter type. The two
        // branches keep the predicate strict so an organisation-
        // template lookup never collides with a team-scoped key (and
        // vice-versa).
        teamId: teamId === null ? { isNull: true } : teamId,
      },
    });
    if (!collision) return candidate;
  }
  return throwHttpError(
    400,
    badRequest(
      `Could not derive a unique key from label (1 000 collisions tried for '${baseKey}').`,
    ),
  );
};
