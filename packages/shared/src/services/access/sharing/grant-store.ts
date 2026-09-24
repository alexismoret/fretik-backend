import { and, eq, ne, or, sql } from "drizzle-orm";
import type { LoadedNode } from "../../../authz/resources/types";
import type { Executor } from "../../../db";
import { accessGrants } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import type { PrincipalRef } from "./principals";

/**
 * The explicit grants of one resource, as the sharing services change them.
 * Read and written inside the caller's transaction, row-locked, so two people
 * changing the same share at once cannot both believe they left someone with
 * full access.
 */

export interface StoredGrant extends PrincipalRef {
  readonly level: AccessLevel;
}

/** The grants of the resource to these principals, locked for the change. */
export const lockGrants = async (
  tx: Executor,
  resource: { type: SharingResourceType; id: string },
  refs: readonly PrincipalRef[],
): Promise<StoredGrant[]> => {
  if (refs.length === 0) return [];
  const rows = await tx
    .select({
      type: accessGrants.principalType,
      id: accessGrants.principalId,
      level: accessGrants.level,
    })
    .from(accessGrants)
    .where(
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
      ),
    )
    .for("update");
  return rows.flatMap((row) =>
    row.type === "invitation" ? [] : [{ ...row, type: row.type }],
  );
};

/**
 * Refuse a change that would leave a restricted resource with no owner and
 * nobody with full access. `losing` are the grants the change removes or
 * lowers below full; they are not counted.
 */
export const assertSomeoneKeepsFullAccess = async (
  tx: Executor,
  node: LoadedNode,
  losing: readonly PrincipalRef[],
): Promise<void> => {
  if (!node.restricted || node.ownerUserId !== null || losing.length === 0) {
    return;
  }
  const [row] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, node.type),
        eq(accessGrants.resourceId, node.id),
        eq(accessGrants.level, "full"),
        ne(accessGrants.principalType, "invitation"),
        ...losing.map(
          (ref) =>
            sql`NOT (${accessGrants.principalType} = ${ref.type} AND ${accessGrants.principalId} = ${ref.id})`,
        ),
      ),
    );
  if ((row?.count ?? 0) === 0) {
    throwHttpError(409, {
      code: ERROR_CODES.LAST_FULL_ACCESS,
      message:
        "Someone must keep full access to this item: its owner is gone and it is restricted.",
    });
  }
};

/** Write these grants at `level`, created or changed, in one statement. */
export const upsertGrants = async (
  tx: Executor,
  input: {
    organizationId: string;
    resource: { type: SharingResourceType; id: string };
    refs: readonly PrincipalRef[];
    level: AccessLevel;
    actorUserId: string;
  },
): Promise<void> => {
  if (input.refs.length === 0) return;
  await tx
    .insert(accessGrants)
    .values(
      input.refs.map((ref) => ({
        organizationId: input.organizationId,
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        principalType: ref.type,
        principalId: ref.id,
        level: input.level,
        grantedByUserId: input.actorUserId,
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
        level: input.level,
        grantedByUserId: input.actorUserId,
        // A share made again is a share without an end date.
        expiresAt: null,
      },
    });
};

/** Remove these grants. */
export const deleteGrants = async (
  tx: Executor,
  resource: { type: SharingResourceType; id: string },
  refs: readonly PrincipalRef[],
): Promise<void> => {
  if (refs.length === 0) return;
  await tx
    .delete(accessGrants)
    .where(
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
      ),
    );
};
