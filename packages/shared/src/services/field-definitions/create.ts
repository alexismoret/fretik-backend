import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { refreshTypedViewAfterCatalogChange } from "../object-types/sync-typed-view";
import { invalidateFieldDefinitionsCache } from "./cache";
import { slugifyFieldKey } from "./slugify-key";
import {
  assertScopeEnabledCap,
  validateFieldDefinitionShape,
} from "./validate";

export type CreateFieldDefinitionInput = {
  organizationId: string;
  teamId: string | null;
  objectTypeId: string;
  // Optional: when omitted, the key is derived from the label and made unique
  // within the scope. Callers that own a stable key (templates, imports) pass it.
  key?: string;
  label: string;
  description?: string | null;
  type: FieldDefinitionType;
  config?: FieldDefinitionConfig;
  isTitle?: boolean;
  aiExtractionEnabled?: boolean;
  vectorizeInclude?: boolean;
  displayInPanel?: boolean;
  displayInFilters?: boolean;
  enabled?: boolean;
  displayOrder?: number;
};

/**
 * Create a single field definition. Validates intrinsic shape (slug, lengths,
 * options cap) and the per-scope enabled cap before insert. Cache
 * invalidation is handled by the caller in the API handler.
 */
/**
 * Resolve a unique field key within a scope: slugify the label (or the
 * caller-provided base), then append `_2`, `_3`, … until it clears the
 * `(objectTypeId, key)` uniqueness index. Avoids surfacing keys to end users.
 */
const resolveUniqueFieldKey = async (data: {
  organizationId: string;
  teamId: string | null;
  objectTypeId: string;
  base: string;
}): Promise<string> => {
  const rows = await db
    .select({ key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.organizationId, data.organizationId),
        eq(fieldDefinitions.objectTypeId, data.objectTypeId),
        data.teamId === null
          ? isNull(fieldDefinitions.teamId)
          : eq(fieldDefinitions.teamId, data.teamId),
      ),
    );
  const taken = new Set(rows.map((r) => r.key));
  const root = slugifyFieldKey(data.base);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${root.slice(0, 60 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export const createFieldDefinition = async (
  input: CreateFieldDefinitionInput,
): Promise<FieldDefinition> => {
  const key = input.key
    ? input.key
    : await resolveUniqueFieldKey({
        organizationId: input.organizationId,
        teamId: input.teamId,
        objectTypeId: input.objectTypeId,
        base: input.label,
      });

  validateFieldDefinitionShape({
    key,
    label: input.label,
    description: input.description ?? null,
    type: input.type,
    config: input.config,
  });

  const willBeEnabled = input.enabled ?? true;
  if (willBeEnabled) {
    await assertScopeEnabledCap({
      organizationId: input.organizationId,
      teamId: input.teamId,
      objectTypeId: input.objectTypeId,
      addEnabled: 1,
    });
  }

  const row = await db.transaction(async (tx) => {
    // Title resolution: every type keeps exactly one title field. The first
    // field of a type becomes its title automatically; an explicit
    // `isTitle: true` promotes this field and demotes the previous one.
    const [existingTitle] = await tx
      .select({ id: fieldDefinitions.id })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.objectTypeId, input.objectTypeId),
          input.teamId === null
            ? isNull(fieldDefinitions.teamId)
            : eq(fieldDefinitions.teamId, input.teamId),
          eq(fieldDefinitions.isTitle, true),
        ),
      )
      .limit(1);
    // Only a text field can be the title (it names the record). A non-text
    // first field is never auto-titled, so it stays a normal, visible field.
    const willBeTitle =
      input.type === "text" && (input.isTitle === true || !existingTitle);
    if (willBeTitle && existingTitle) {
      await tx
        .update(fieldDefinitions)
        .set({ isTitle: false })
        .where(eq(fieldDefinitions.id, existingTitle.id));
    }

    const [inserted] = await tx
      .insert(fieldDefinitions)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        objectTypeId: input.objectTypeId,
        key,
        label: input.label,
        description: input.description ?? null,
        type: input.type,
        config: input.config ?? {},
        isTitle: willBeTitle,
        aiExtractionEnabled: input.aiExtractionEnabled ?? true,
        vectorizeInclude: input.vectorizeInclude ?? true,
        displayInPanel: input.displayInPanel ?? true,
        displayInFilters: input.displayInFilters ?? false,
        enabled: willBeEnabled,
        displayOrder: input.displayOrder ?? 0,
      })
      .returning();
    if (!inserted) {
      return throwHttpError(500, internalError());
    }
    // Add the new column to the team's typed view (+ index if filterable),
    // atomic with the insert.
    await refreshTypedViewAfterCatalogChange({
      tx,
      organizationId: input.organizationId,
      objectTypeId: input.objectTypeId,
      teamId: input.teamId,
    });
    return inserted;
  });
  await invalidateFieldDefinitionsCache({
    organizationId: input.organizationId,
    teamId: input.teamId,
  });
  return row;
};
