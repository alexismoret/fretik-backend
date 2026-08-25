import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import {
  collections,
  fieldDefinitions,
  type NewFieldDefinition,
} from "../../db/schema";
import { STARTER_COLLECTION_TEMPLATE } from "../../templates/collections/starter";

/**
 * Seed the starter collections (company, note, task) and their fields
 * at org-template scope (`teamId IS NULL`, `isSystem: false`) for a new
 * organization. Unlike `seedSystemOntology` (the one required `document` type),
 * every type here is fully editable and deletable — a generic workspace must
 * not force a CRM ontology on a team.
 *
 * Runs in ONE transaction so the types and their fields commit together (a
 * failed field insert never leaves field-less starter types behind).
 * Idempotent (`onConflictDoNothing`) — safe to re-run. Call from the
 * org-creation hook; teams inherit these field definitions via
 * `duplicateOrgDefsToTeam` at team creation, exactly like the document fields.
 */
export const seedStarterCollections = async (
  organizationId: string,
): Promise<void> => {
  const types = STARTER_COLLECTION_TEMPLATE.types;

  await db.transaction(async (tx) => {
    await tx
      .insert(collections)
      .values(
        types.map((t) => ({
          organizationId,
          teamId: null,
          key: t.key,
          label: t.label,
          labelPlural: t.labelPlural,
          description: t.description ?? null,
          icon: t.icon,
          isSystem: false,
        })),
      )
      .onConflictDoNothing();

    const rows = await tx
      .select({ id: collections.id, key: collections.key })
      .from(collections)
      .where(
        and(
          eq(collections.organizationId, organizationId),
          isNull(collections.teamId),
        ),
      );
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));

    const fieldRows: NewFieldDefinition[] = [];
    for (const type of types) {
      const collectionId = idByKey.get(type.key);
      if (!collectionId) continue;
      for (const field of type.fields) {
        fieldRows.push({
          organizationId,
          teamId: null,
          collectionId,
          key: field.key,
          label: field.label,
          description: field.description ?? null,
          type: field.type,
          config: field.config ?? {},
          isTitle: field.isTitle ?? false,
          displayOrder: field.displayOrder,
        });
      }
    }
    if (fieldRows.length > 0) {
      await tx.insert(fieldDefinitions).values(fieldRows).onConflictDoNothing();
    }
  });
};
