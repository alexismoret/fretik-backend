// oxlint-disable no-await-in-loop
import { count, eq } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { documentFieldValues, fieldDefinitions } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import type { FieldDefinitionOperation } from "../../schemas/field-definitions";
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
          resourceType: "document",
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
          // The AI-suggest payload does not carry `resourceType` — only
          // "document" is supported today, and keeping it out of the
          // schema spares the LLM one redundant field. Default here.
          resourceType: "document",
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
          const [c] = await tx
            .select({ n: count() })
            .from(documentFieldValues)
            .where(eq(documentFieldValues.fieldKey, existing.key));
          if ((c?.n ?? 0) > 0 && !op.patch.cascade) {
            return throwHttpError(
              400,
              badRequest(
                `Cannot change type of '${existing.key}' while values exist (use cascade=true).`,
              ),
            );
          }
          if ((c?.n ?? 0) > 0 && op.patch.cascade) {
            await tx
              .delete(documentFieldValues)
              .where(eq(documentFieldValues.fieldKey, existing.key));
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
          await tx
            .delete(documentFieldValues)
            .where(eq(documentFieldValues.fieldKey, existing.key));
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
        // Migrate any existing values pointing to the old key before
        // changing the def — the unique (documentId, fieldKey) constraint
        // would otherwise collide.
        await tx
          .update(documentFieldValues)
          .set({ fieldKey: op.newKey })
          .where(eq(documentFieldValues.fieldKey, existing.key));
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
      resourceType: "document",
      addEnabled: 0,
    });

    return { created, updated, deleted, renamed };
  });

  await invalidateFieldDefinitionsCache({ organizationId, teamId });
  return result;
};

const assertOwnedById = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  organizationId: string;
  teamId: string | null;
  resourceType: "document";
  baseKey: string;
}): Promise<string> => {
  const { tx, organizationId, teamId, resourceType, baseKey } = data;

  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? baseKey : `${baseKey}_${i + 1}`.slice(0, 60);
    const collision = await tx.query.fieldDefinitions.findFirst({
      columns: { id: true },
      where: {
        organizationId,
        resourceType,
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
