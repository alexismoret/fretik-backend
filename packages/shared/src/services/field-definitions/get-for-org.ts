import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions, objectTypes } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { DOCUMENT_TYPE_KEY } from "../object-types/constants";
import { fieldDefinitionsCacheKeyOrg } from "./cache";

/**
 * Fetch every field definition at organization scope (`teamId IS NULL`).
 * These rows are the template Fretik copies into a freshly created team —
 * editing them never propagates to existing teams.
 *
 * The object type is resolved by `objectTypeId` when provided, otherwise by
 * `objectTypeKey` (default `document_record`) via an INNER JOIN on `object_types`.
 *
 * Cached under `organization:{orgId}:field-definitions:…` (30 min TTL).
 *
 * The relational query API does not natively express `IS NULL` predicates
 * cleanly, so this drops down to the builder for the `isNull(teamId)` clause.
 */
export const getFieldDefinitionsForOrganization = async (data: {
  organizationId: string;
  objectTypeId?: string;
  objectTypeKey?: string;
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const {
    organizationId,
    objectTypeId,
    objectTypeKey = DOCUMENT_TYPE_KEY,
    includeDisabled = false,
  } = data;

  return await selectOrCache(
    async () => {
      const conditions = [
        eq(fieldDefinitions.organizationId, organizationId),
        isNull(fieldDefinitions.teamId),
      ];
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
    fieldDefinitionsCacheKeyOrg(
      organizationId,
      objectTypeId ?? objectTypeKey,
      includeDisabled,
    ),
  );
};
