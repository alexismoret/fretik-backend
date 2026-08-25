import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { linkTypes } from "../../db/schema";
import { selectOrCache } from "../../lib/redis";

/**
 * Resolve the org-scoped (`teamId IS NULL`) link-type id for a normalized key —
 * the document pipeline uses it to find the seeded system `mentions` relation.
 * Returns null when absent (non-throwing, like `resolveCollectionId`) so the
 * caller can degrade gracefully rather than fail a whole document. Cached 30 min
 * under `organization:{orgId}:link-type-id:{key}`.
 */
export const resolveOrgLinkTypeId = async (data: {
  organizationId: string;
  key: string;
}): Promise<string | null> => {
  const { organizationId, key } = data;

  return await selectOrCache(async () => {
    const [row] = await db
      .select({ id: linkTypes.id })
      .from(linkTypes)
      .where(
        and(
          eq(linkTypes.organizationId, organizationId),
          eq(linkTypes.normalizedKey, key),
          isNull(linkTypes.teamId),
        ),
      );
    return row?.id ?? null;
  }, `organization:${organizationId}:link-type-id:${key}`);
};
