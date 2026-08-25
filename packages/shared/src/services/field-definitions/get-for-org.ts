import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { collections, fieldDefinitions } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { DOCUMENT_COLLECTION_KEY } from "../collections/constants";
import { fieldDefinitionsCacheKeyOrg } from "./cache";

/**
 * Fetch every field definition at organization scope (`teamId IS NULL`).
 * These rows are the template Fretik copies into a freshly created team —
 * editing them never propagates to existing teams.
 *
 * The collection is resolved by `collectionId` when provided, otherwise by
 * `collectionKey` (default `document_record`) via an INNER JOIN on `collections`.
 *
 * Cached under `organization:{orgId}:field-definitions:…` (30 min TTL).
 *
 * The relational query API does not natively express `IS NULL` predicates
 * cleanly, so this drops down to the builder for the `isNull(teamId)` clause.
 */
export const getFieldDefinitionsForOrganization = async (data: {
  organizationId: string;
  collectionId?: string;
  collectionKey?: string;
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const {
    organizationId,
    collectionId,
    collectionKey = DOCUMENT_COLLECTION_KEY,
    includeDisabled = false,
  } = data;

  return await selectOrCache(
    async () => {
      const conditions = [
        eq(fieldDefinitions.organizationId, organizationId),
        isNull(fieldDefinitions.teamId),
      ];
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
    fieldDefinitionsCacheKeyOrg(
      organizationId,
      collectionId ?? collectionKey,
      includeDisabled,
    ),
  );
};
