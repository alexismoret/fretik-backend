import { and, asc, eq } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { collections, fieldDefinitions } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { DOCUMENT_COLLECTION_KEY } from "../collections/constants";
import { fieldDefinitionsCacheKeyTeam } from "./cache";

/**
 * Fetch every enabled field definition for a team. Direct lookup — no
 * org-side fallback. Inheritance happens at team creation time
 * (`duplicate-org-to-team.ts`), so the team table already contains its
 * own snapshot of every field it should see.
 *
 * The collection is resolved by `collectionId` when provided, otherwise by
 * `collectionKey` (default `document_record`) via an INNER JOIN on `collections`
 * — which avoids a separate org lookup to map the key to an id.
 *
 * Cached under `team:{teamId}:field-definitions:{collectionId|key}:…` with a
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
  collectionId?: string;
  collectionKey?: string;
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const {
    teamId,
    collectionId,
    collectionKey = DOCUMENT_COLLECTION_KEY,
    includeDisabled = false,
  } = data;

  return await selectOrCache(
    async () => {
      const conditions = [eq(fieldDefinitions.teamId, teamId)];
      if (collectionId) {
        conditions.push(eq(fieldDefinitions.collectionId, collectionId));
      } else {
        conditions.push(eq(collections.key, collectionKey));
      }
      if (!includeDisabled) {
        conditions.push(eq(fieldDefinitions.enabled, true));
      }

      if (collectionId) {
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
          collections,
          eq(fieldDefinitions.collectionId, collections.id),
        )
        .where(and(...conditions))
        .orderBy(asc(fieldDefinitions.displayOrder));
      return rows.map((r) => r.field_definitions);
    },
    fieldDefinitionsCacheKeyTeam(
      teamId,
      collectionId ?? collectionKey,
      includeDisabled,
    ),
  );
};
