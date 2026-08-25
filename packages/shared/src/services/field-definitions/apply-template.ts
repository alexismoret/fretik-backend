import { and, eq, isNull, notInArray } from "drizzle-orm";
import db from "../../db";
import type { NewFieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  DOCUMENT_FIELD_TEMPLATES,
  translateTemplateKey,
} from "../../templates/document-fields";
import type {
  DocumentFieldTemplate,
  FieldDefinitionSeed,
} from "../../templates/document-fields/types";
import { refreshCollectionTableAfterCatalogChange } from "../collection-schema/catalog-sync";
import { DOCUMENT_COLLECTION_KEY } from "../collections/constants";
import { resolveOrgCollectionId } from "../collections/resolve";
import { invalidateFieldDefinitionsCache } from "./cache";
import { FIELD_DEFINITION_LIMITS } from "./constants";
import { getTeamLocale } from "./get-locale";

/**
 * Apply a code-defined template to a scope.
 *
 * Scope is implicit:
 *   - `teamId` set → team scope. Used by the settings UI when the user picks
 *     "Apply template" and by `duplicate-org-to-team.ts` (which goes through
 *     the duplicate service, not this one).
 *   - `teamId === null` → organization scope. Used at organization creation
 *     (auto-applies the `default` template) and by the admin org-fields page.
 *
 * Modes:
 *   - `replace` (default at org-creation, on-demand otherwise): drop the
 *     scope's existing field definitions FOR THE DOCUMENT TYPE, then insert
 *     the template. Other collections' fields are never touched, and neither
 *     is the document's locked title or its computed provenance fields — those
 *     belong to the system ontology, not to a template.
 *   - `merge`: insert template fields whose `key` does not already exist in
 *     the scope. Leaves existing fields untouched.
 *
 * Translation: every text the template references is an i18n key resolved
 * against the `locale` argument. The resolved English text lands in the DB
 * and is fully editable by the user from that point on — translations are
 * a one-shot seed, not a live binding.
 */
export const applyDocumentFieldTemplate = async (data: {
  organizationId: string;
  teamId: string | null;
  templateKey: string;
  mode?: "replace" | "merge";
  /**
   * Override the auto-resolved locale. When omitted: team scope reads
   * `teamSettings.lang`; org scope falls back to `"en"`.
   */
  locale?: string;
}): Promise<{ inserted: number; skipped: number; dropped: number }> => {
  const {
    organizationId,
    teamId,
    templateKey,
    mode = "replace",
    locale: localeOverride,
  } = data;

  const locale =
    localeOverride ?? (teamId ? await getTeamLocale(teamId) : "en");

  // These are document-field templates — resolve the system document type
  // once and stamp every seeded row with it.
  const collectionId = await resolveOrgCollectionId({
    organizationId,
    key: DOCUMENT_COLLECTION_KEY,
  });

  const template = DOCUMENT_FIELD_TEMPLATES[templateKey];
  if (!template) {
    return throwHttpError(400, badRequest(`Unknown template '${templateKey}'`));
  }

  const seeds = template.fields;
  if (seeds.length > FIELD_DEFINITION_LIMITS.MAX_ENABLED_PER_SCOPE) {
    return throwHttpError(
      400,
      badRequest(
        `Template '${templateKey}' has ${seeds.length} fields, exceeding the ${FIELD_DEFINITION_LIMITS.MAX_ENABLED_PER_SCOPE}-field cap.`,
      ),
    );
  }

  const result = await db.transaction(async (tx) => {
    // 1. Drop existing if mode=replace, otherwise build the set of keys to
    //    skip (already-present keys in merge mode).
    let dropped = 0;
    let existingKeys: Set<string> = new Set();
    if (mode === "replace") {
      const droppedRows = await tx
        .delete(fieldDefinitions)
        .where(
          and(
            scopePredicate({ organizationId, teamId, collectionId }),
            // Mirror the guards the single-field delete service enforces: the
            // document's title is locked, and the provenance fields are
            // computed. A template owns neither.
            eq(fieldDefinitions.isTitle, false),
            notInArray(fieldDefinitions.type, ["created_time", "created_by"]),
          ),
        )
        .returning({ key: fieldDefinitions.key });
      dropped = droppedRows.length;
      // The dropped defs' columns (and their values) are removed by the table
      // reconcile below — no manual cascade needed.
    } else {
      const existing = await tx
        .select({ key: fieldDefinitions.key })
        .from(fieldDefinitions)
        .where(scopePredicate({ organizationId, teamId, collectionId }));
      existingKeys = new Set(existing.map((r) => r.key));
    }

    // 2. Insert seeds, skipping any whose key already exists in merge mode.
    const rows: NewFieldDefinition[] = [];
    let skipped = 0;
    for (const seed of seeds) {
      if (existingKeys.has(seed.key)) {
        skipped += 1;
        continue;
      }
      rows.push(
        buildRowFromSeed({
          seed,
          organizationId,
          teamId,
          collectionId,
          locale,
        }),
      );
    }

    let inserted = 0;
    if (rows.length > 0) {
      const insertResult = await tx
        .insert(fieldDefinitions)
        .values(rows)
        .returning({ id: fieldDefinitions.id });
      inserted = insertResult.length;
    }

    // Reconcile the team's extension table + search vectors for the
    // (replaced/merged) field set, atomic with the template application.
    await refreshCollectionTableAfterCatalogChange({
      tx,
      organizationId,
      collectionId,
      teamId,
    });

    return { inserted, skipped, dropped };
  });

  await invalidateFieldDefinitionsCache({ organizationId, teamId });
  return result;
};

const scopePredicate = (data: {
  organizationId: string;
  teamId: string | null;
  collectionId: string;
}) => {
  const { organizationId, teamId, collectionId } = data;
  const scope =
    teamId === null
      ? and(
          eq(fieldDefinitions.organizationId, organizationId),
          isNull(fieldDefinitions.teamId),
        )
      : eq(fieldDefinitions.teamId, teamId);
  // Document-field templates own the document type's fields and nothing else.
  return and(scope, eq(fieldDefinitions.collectionId, collectionId));
};

const buildRowFromSeed = (data: {
  seed: FieldDefinitionSeed;
  organizationId: string;
  teamId: string | null;
  collectionId: string;
  locale: string;
}): NewFieldDefinition => {
  const { seed, organizationId, teamId, collectionId, locale } = data;
  const label = translateTemplateKey(seed.labelKey, locale);
  const description = seed.descriptionKey
    ? translateTemplateKey(seed.descriptionKey, locale)
    : null;

  // No explicit `FieldDefinitionConfig` annotation: the union would trigger
  // excess-property checking on this fresh literal (options is select-only).
  // The inferred type is checked structurally against the column type below.
  const config =
    seed.options && seed.options.length > 0
      ? {
          ...(seed.configExtras ?? {}),
          options: seed.options.map((option) => ({
            value: option.value,
            label: translateTemplateKey(option.labelKey, locale),
            color: option.color,
            icon: option.icon,
          })),
        }
      : { ...(seed.configExtras ?? {}) };

  return {
    organizationId,
    teamId,
    collectionId,
    key: seed.key,
    label,
    description,
    type: seed.type,
    config,
    aiExtractionEnabled: seed.aiExtractionEnabled ?? true,
    vectorizeInclude: seed.vectorizeInclude ?? true,
    displayInPanel: seed.displayInPanel ?? true,
    enabled: seed.enabled ?? true,
    displayOrder: seed.displayOrder,
  };
};

/**
 * Shape returned by `list-templates.ts` for the UI selector — minimal,
 * already-translated metadata (no field details).
 */
export type DocumentFieldTemplateSummary = {
  key: string;
  label: string;
  description: string;
  fieldCount: number;
};

export const summariseTemplate = (
  template: DocumentFieldTemplate,
  locale: string,
): DocumentFieldTemplateSummary => ({
  key: template.key,
  label: translateTemplateKey(template.labelKey, locale),
  description: translateTemplateKey(template.descriptionKey, locale),
  fieldCount: template.fields.length,
});
