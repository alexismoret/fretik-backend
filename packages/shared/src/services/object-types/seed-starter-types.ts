import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import {
  fieldDefinitions,
  type NewFieldDefinition,
  objectTypes,
} from "../../db/schema";
import { STARTER_OBJECT_TYPE_TEMPLATE } from "../../templates/object-types/starter";

/**
 * Seed the starter object types (company, person, note, task) and their fields
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
export const seedStarterObjectTypes = async (
  organizationId: string,
): Promise<void> => {
  const types = STARTER_OBJECT_TYPE_TEMPLATE.types;

  await db.transaction(async (tx) => {
    await tx
      .insert(objectTypes)
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
      .select({ id: objectTypes.id, key: objectTypes.key })
      .from(objectTypes)
      .where(
        and(
          eq(objectTypes.organizationId, organizationId),
          isNull(objectTypes.teamId),
        ),
      );
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));

    const fieldRows: NewFieldDefinition[] = [];
    for (const type of types) {
      const objectTypeId = idByKey.get(type.key);
      if (!objectTypeId) continue;
      for (const field of type.fields) {
        fieldRows.push({
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
    if (fieldRows.length > 0) {
      await tx.insert(fieldDefinitions).values(fieldRows).onConflictDoNothing();
    }
  });
};
