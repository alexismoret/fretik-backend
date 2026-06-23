import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { objectTypes } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { selectOrCache } from "../../lib/redis";

/**
 * Resolve the org-scoped (`teamId IS NULL`) object-type id for a key.
 *
 * Used by field-definition create/validate/batch-apply/apply-template and the
 * API handler — all carry an `organizationId`. System types
 * (`document`/`organization`/`person`) are seeded at org creation, so a missing
 * row is a 404 (a broken invariant rather than a user error).
 *
 * Cached under `organization:{orgId}:object-type-id:{key}` (30 min TTL).
 */
export const resolveOrgObjectTypeId = async (data: {
  organizationId: string;
  key: string;
}): Promise<string> => {
  const { organizationId, key } = data;

  return await selectOrCache(async () => {
    const [row] = await db
      .select({ id: objectTypes.id })
      .from(objectTypes)
      .where(
        and(
          eq(objectTypes.organizationId, organizationId),
          eq(objectTypes.key, key),
          isNull(objectTypes.teamId),
        ),
      );
    if (!row) {
      return throwHttpError(
        404,
        notFound(`Object type '${key}' not found for organization`),
      );
    }
    return row.id;
  }, `organization:${organizationId}:object-type-id:${key}`);
};

/**
 * Resolve an object-type id for a key, preferring the team-scoped type and
 * falling back to the org/system one (`teamId IS NULL`). For future
 * team-scoped types; returns null when neither exists.
 *
 * Cached under `team:{teamId}:object-type-id:{key}` (or the org variant when
 * `teamId` is omitted), 30 min TTL.
 */
export const resolveObjectTypeId = async (data: {
  organizationId: string;
  teamId?: string | null;
  key: string;
}): Promise<string | null> => {
  const { organizationId, teamId, key } = data;

  const cacheKey =
    teamId == null
      ? `organization:${organizationId}:object-type-id:${key}`
      : `team:${teamId}:object-type-id:${key}`;

  return await selectOrCache(async () => {
    if (teamId != null) {
      const [teamRow] = await db
        .select({ id: objectTypes.id })
        .from(objectTypes)
        .where(and(eq(objectTypes.teamId, teamId), eq(objectTypes.key, key)));
      if (teamRow) {
        return teamRow.id;
      }
    }

    const [orgRow] = await db
      .select({ id: objectTypes.id })
      .from(objectTypes)
      .where(
        and(
          eq(objectTypes.organizationId, organizationId),
          eq(objectTypes.key, key),
          isNull(objectTypes.teamId),
        ),
      );
    return orgRow?.id ?? null;
  }, cacheKey);
};
