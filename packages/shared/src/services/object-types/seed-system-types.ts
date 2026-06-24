import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import {
  type FieldDefinitionConfig,
  fieldDefinitions,
  type FieldDefinitionType,
  linkTypes,
  type NewFieldDefinition,
  type NewLinkType,
  objectTypes,
} from "../../db/schema";

/**
 * Key of the one generic system relation: "document mentions X". The document
 * pipeline depends on it (replaces the old per-role document↔entity links).
 * Polymorphic and industry-agnostic — every other relation is user/AI-created.
 */
export const MENTIONS_LINK_TYPE_KEY = "mentions";

type SeedField = {
  key: string;
  label: string;
  type: FieldDefinitionType;
  isTitle?: boolean;
  config?: FieldDefinitionConfig;
  displayInFilters?: boolean;
  displayOrder: number;
};

type SeedObjectType = {
  key: string;
  label: string;
  labelPlural: string;
  icon: string;
  fields: SeedField[];
};

/**
 * The ONLY truly system object type. `document` is delete-protected (the delete
 * service refuses it): it is the anchor for document field definitions and the
 * uploaded-file record mirror, so the upload pipeline depends on it. It carries
 * no fields here — they come from the document-field template applied right
 * after (org-creation hook).
 *
 * Everything else a team starts with (company, person, note, task) ships as a
 * deletable, editable STARTER template (`templates/object-types`), not as a
 * hardcoded system type — a generic B2B workspace must not force a CRM-ish
 * ontology on every team. Relations are NOT seeded — link types are created on
 * demand by users / the AI (canonicalized to avoid sprawl).
 */
const SYSTEM_OBJECT_TYPES: SeedObjectType[] = [
  {
    key: "document",
    label: "Document",
    labelPlural: "Documents",
    icon: "file-text",
    fields: [],
  },
];

/**
 * Seed the standard object types (+ their generic default field definitions, at
 * org-template scope) for an organization. Idempotent — safe to re-run. Called
 * from the org-creation hook BEFORE the document-field template is applied (the
 * template resolves the `document` object type and throws if it is missing).
 * Teams inherit the org-scope field definitions via `duplicateOrgDefsToTeam` at
 * team creation. Existing orgs were seeded by the dynamic-data migration.
 */
export const seedSystemOntology = async (
  organizationId: string,
): Promise<void> => {
  await db
    .insert(objectTypes)
    .values(
      SYSTEM_OBJECT_TYPES.map((t) => ({
        organizationId,
        teamId: null,
        key: t.key,
        label: t.label,
        labelPlural: t.labelPlural,
        icon: t.icon,
        isSystem: true,
      })),
    )
    .onConflictDoNothing();

  const types = await db
    .select({ id: objectTypes.id, key: objectTypes.key })
    .from(objectTypes)
    .where(
      and(
        eq(objectTypes.organizationId, organizationId),
        isNull(objectTypes.teamId),
      ),
    );
  const idByKey = new Map(types.map((t) => [t.key, t.id]));

  const rows: NewFieldDefinition[] = [];
  for (const type of SYSTEM_OBJECT_TYPES) {
    const objectTypeId = idByKey.get(type.key);
    if (!objectTypeId) continue;
    for (const field of type.fields) {
      rows.push({
        organizationId,
        teamId: null,
        objectTypeId,
        key: field.key,
        label: field.label,
        type: field.type,
        config: field.config ?? {},
        isTitle: field.isTitle ?? false,
        displayInFilters: field.displayInFilters ?? false,
        displayOrder: field.displayOrder,
      });
    }
  }
  if (rows.length > 0) {
    await db.insert(fieldDefinitions).values(rows).onConflictDoNothing();
  }

  // The single generic system relation the document pipeline depends on:
  // "document mentions X". Polymorphic (toObjectType NULL) so a document can
  // mention a company, a person, or any future type — no industry-specific
  // roles. Industry relations (a pricing's carrier, …) are NOT seeded; users
  // and the AI create those, canonicalized to avoid sprawl. Idempotent on the
  // org-scope `(organizationId, normalizedKey) WHERE team_id IS NULL` index.
  const documentTypeId = idByKey.get("document");
  if (documentTypeId) {
    const mentions: NewLinkType = {
      organizationId,
      teamId: null,
      key: MENTIONS_LINK_TYPE_KEY,
      normalizedKey: MENTIONS_LINK_TYPE_KEY,
      label: "Mentions",
      fromObjectTypeId: documentTypeId,
      toObjectTypeId: null,
      cardinality: "many_to_many",
      inverseKey: "mentioned_in",
      inverseLabel: "Mentioned in",
      source: "system",
    };
    await db.insert(linkTypes).values(mentions).onConflictDoNothing();
  }
};
