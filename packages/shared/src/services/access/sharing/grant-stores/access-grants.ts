import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import type { Executor } from "../../../../db";
import { accessGrants, user } from "../../../../db/schema";
import type { GrantStore, StoredGrant, StoredHolder } from "../grant-store";
import type { PrincipalRef } from "../principals";

/**
 * The engine's own grants (`access_grants`), where every shareable type keeps
 * who it was shared with unless it keeps that elsewhere (`grant-store.ts`).
 */

type Resource = Parameters<GrantStore["lock"]>[1];

/** The rows of these principals on the resource. */
const matching = (resource: Resource, refs: readonly PrincipalRef[]) =>
  and(
    eq(accessGrants.resourceType, resource.type),
    eq(accessGrants.resourceId, resource.id),
    or(
      ...refs.map((ref) =>
        and(
          eq(accessGrants.principalType, ref.type),
          eq(accessGrants.principalId, ref.id),
        ),
      ),
    ),
  );

export const accessGrantStore: GrantStore = {
  lock: async (tx, resource, refs): Promise<StoredGrant[]> => {
    if (refs.length === 0) return [];
    const rows = await tx
      .select({
        type: accessGrants.principalType,
        id: accessGrants.principalId,
        level: accessGrants.level,
      })
      .from(accessGrants)
      .where(matching(resource, refs))
      .for("update");
    return rows.flatMap((row) =>
      row.type === "invitation" ? [] : [{ ...row, type: row.type }],
    );
  },

  list: async (executor: Executor, resource): Promise<StoredHolder[]> => {
    const rows = await executor
      .select({
        type: accessGrants.principalType,
        id: accessGrants.principalId,
        level: accessGrants.level,
        grantedAt: accessGrants.createdAt,
        grantedByUserId: accessGrants.grantedByUserId,
        grantedByName: user.name,
      })
      .from(accessGrants)
      .leftJoin(user, eq(user.id, accessGrants.grantedByUserId))
      .where(
        and(
          eq(accessGrants.resourceType, resource.type),
          eq(accessGrants.resourceId, resource.id),
          ne(accessGrants.principalType, "invitation"),
          or(
            isNull(accessGrants.expiresAt),
            gt(accessGrants.expiresAt, new Date()),
          ),
        ),
      );
    return rows.flatMap((row): StoredHolder[] =>
      row.type === "invitation"
        ? []
        : [
            {
              type: row.type,
              id: row.id,
              level: row.level,
              grantedAt: row.grantedAt,
              grantedBy:
                row.grantedByUserId === null || row.grantedByName === null
                  ? null
                  : { userId: row.grantedByUserId, name: row.grantedByName },
            },
          ],
    );
  },

  upsert: async (tx, write): Promise<void> => {
    if (write.refs.length === 0) return;
    await tx
      .insert(accessGrants)
      .values(
        write.refs.map((ref) => ({
          organizationId: write.organizationId,
          resourceType: write.resource.type,
          resourceId: write.resource.id,
          principalType: ref.type,
          principalId: ref.id,
          level: write.level,
          grantedByUserId: write.actorUserId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          accessGrants.resourceType,
          accessGrants.resourceId,
          accessGrants.principalType,
          accessGrants.principalId,
        ],
        set: {
          level: write.level,
          grantedByUserId: write.actorUserId,
          // A share made again is a share without an end date.
          expiresAt: null,
        },
      });
  },

  remove: async (tx, resource, refs): Promise<void> => {
    if (refs.length === 0) return;
    await tx.delete(accessGrants).where(matching(resource, refs));
  },
};
