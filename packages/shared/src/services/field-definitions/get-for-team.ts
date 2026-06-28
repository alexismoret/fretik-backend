import { and, asc, eq } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions, objectTypes } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { DOCUMENT_TYPE_KEY } from "../object-types/constants";
import { fieldDefinitionsCacheKeyTeam } from "./cache";

/**
 * Fetch every enabled field definition for a team. Direct lookup — no
 * org-side fallback. Inheritance happens at team creation time
 * (`duplicate-org-to-team.ts`), so the team table already contains its
 * own snapshot of every field it should see.
 *
 * The object type is resolved by `objectTypeId` when provided, otherwise by
 * `objectTypeKey` (default `document_record`) via an INNER JOIN on `object_types`
 * — which avoids a separate org lookup to map the key to an id.
 *
 * Cached under `team:{teamId}:field-definitions:{objectTypeId|key}:…` with a
 * 30-min TTL. Writes invalidate the matching prefix via
 * `invalidateFieldDefinitionsCache`.
 *
 * Consumers:
 *   - upload.ts → builds the pre-extract payload
 *   - retrieve.ts → returns defs alongside document details for dynamic rendering
 *   - vector-refresh.ts → drives which custom fields land in the semantic header
 *   - chatbot tools → filters whitelist
 */
export const getFieldDefinitionsForTeam = async (data: {
  teamId: string;
  objectTypeId?: string;
  objectTypeKey?: string;
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const {
    teamId,
    objectTypeId,
    objectTypeKey = DOCUMENT_TYPE_KEY,
    includeDisabled = false,
  } = data;

  return await selectOrCache(
    async () => {
      const conditions = [eq(fieldDefinitions.teamId, teamId)];
      if (objectTypeId) {
        conditions.push(eq(fieldDefinitions.objectTypeId, objectTypeId));
      } else {
        conditions.push(eq(objectTypes.key, objectTypeKey));
      }
      if (!includeDisabled) {
        conditions.push(eq(fieldDefinitions.enabled, true));
      }

      if (objectTypeId) {
        return await db
          .select()
          .from(fieldDefinitions)
          .where(and(...conditions))
          .orderBy(asc(fieldDefinitions.displayOrder));
      }

      const rows = await db
        .select()
        .from(fieldDefinitions)
        .innerJoin(
          objectTypes,
          eq(fieldDefinitions.objectTypeId, objectTypes.id),
        )
        .where(and(...conditions))
        .orderBy(asc(fieldDefinitions.displayOrder));
      return rows.map((r) => r.field_definitions);
    },
    fieldDefinitionsCacheKeyTeam(
      teamId,
      objectTypeId ?? objectTypeKey,
      includeDisabled,
    ),
  );
};
