import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";
import { fieldDefinitionsCacheKeyTeam } from "./cache";

/**
 * Fetch every enabled field definition for a team. Direct lookup — no
 * org-side fallback. Inheritance happens at team creation time
 * (`duplicate-org-to-team.ts`), so the team table already contains its
 * own snapshot of every field it should see.
 *
 * Cached under `team:{teamId}:field-definitions:{resourceType}:…` with a
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
  resourceType?: FieldDefinition["resourceType"];
  includeDisabled?: boolean;
}): Promise<FieldDefinition[]> => {
  const { teamId, resourceType = "document", includeDisabled = false } = data;

  return await selectOrCache(
    () =>
      db.query.fieldDefinitions.findMany({
        where: includeDisabled
          ? { teamId, resourceType }
          : { teamId, resourceType, enabled: true },
        orderBy: { displayOrder: "asc" },
      }),
    fieldDefinitionsCacheKeyTeam(teamId, resourceType, includeDisabled),
  );
};
