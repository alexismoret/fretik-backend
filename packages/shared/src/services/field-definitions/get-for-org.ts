import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { fieldDefinitionsCacheKeyOrg } from "./cache";

/**
 * Fetch every field definition at organization scope (`teamId IS NULL`).
 * These rows are the template Fretik copies into a freshly created team —
 * editing them never propagates to existing teams.
 *
 * Cached under `organization:{orgId}:field-definitions:…` (30 min TTL).
 *
 * The relational query API does not natively express `IS NULL` predicates
 * cleanly, so this drops down to the builder for the `isNull(teamId)` clause.
 */
export const getFieldDefinitionsForOrganization = async (data: {
  organizationId: string;
  resourceType?: FieldDefinition["resourceType"];
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const {
    organizationId,
    resourceType = "document",
    includeDisabled = false,
  } = data;

  return await selectOrCache(
    async () => {
      const conditions = [
        eq(fieldDefinitions.organizationId, organizationId),
        eq(fieldDefinitions.resourceType, resourceType),
        isNull(fieldDefinitions.teamId),
      ];
      if (!includeDisabled) {
        conditions.push(eq(fieldDefinitions.enabled, true));
      }

      return await db
        .select()
        .from(fieldDefinitions)
        .where(and(...conditions))
        .orderBy(asc(fieldDefinitions.displayOrder));
    },
    fieldDefinitionsCacheKeyOrg(organizationId, resourceType, includeDisabled),
  );
};
