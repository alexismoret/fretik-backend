import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import db, { type Executor } from "../../db";
import { accessGrants } from "../../db/schema";
import type { AccessResourceType } from "../../schemas/access";
import type { GrantFact } from "../principal";

/**
 * The explicit grants (`access_grants`) on a batch of resources of one type,
 * keyed by resource id. Expired grants give nothing and are left out; so are
 * grants to a guest who has not accepted yet (`invitation`), which give
 * nobody anything until they are converted.
 */
export const loadExplicitGrants = async (
  type: AccessResourceType,
  ids: readonly string[],
  executor: Executor = db,
): Promise<Map<string, GrantFact[]>> => {
  const byResource = new Map<string, GrantFact[]>();
  if (ids.length === 0) return byResource;

  const rows = await executor
    .select({
      resourceId: accessGrants.resourceId,
      principalType: accessGrants.principalType,
      principalId: accessGrants.principalId,
      level: accessGrants.level,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, type),
        inArray(accessGrants.resourceId, [...new Set(ids)]),
        ne(accessGrants.principalType, "invitation"),
        or(
          isNull(accessGrants.expiresAt),
          gt(accessGrants.expiresAt, new Date()),
        ),
      ),
    );

  for (const row of rows) {
    if (row.principalType === "invitation") continue;
    const list = byResource.get(row.resourceId) ?? [];
    list.push({
      principalType: row.principalType,
      principalId: row.principalId,
      level: row.level,
    });
    byResource.set(row.resourceId, list);
  }
  return byResource;
};

/** Append grants from another source to a per-resource map. */
export const mergeGrants = (
  into: Map<string, GrantFact[]>,
  resourceId: string,
  grants: readonly GrantFact[],
): void => {
  if (grants.length === 0) return;
  into.set(resourceId, [...(into.get(resourceId) ?? []), ...grants]);
};
