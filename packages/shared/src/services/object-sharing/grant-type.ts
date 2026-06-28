import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { ObjectGrant, ObjectPermission } from "../../db/schema";
import { objectGrants } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { assertSharableType, assertValidGrantee } from "./validate";

/**
 * Grant a whole object type to another team (or org-wide when
 * `granteeTeamId` is null) — "team A shares its `client` type with team B".
 * Idempotent on `(objectTypeId, granteeTeamId)`: a second grant updates the
 * permission instead of duplicating. The RLS helper `fretik_type_granted`
 * reads these rows, so every record of the type becomes visible to the grantee.
 */
export const grantObjectType = async (input: {
  organizationId: string;
  objectTypeId: string;
  ownerTeamId: string;
  granteeTeamId: string | null;
  permission?: ObjectPermission;
  createdByUserId?: string | null;
}): Promise<ObjectGrant> => {
  await assertSharableType({
    objectTypeId: input.objectTypeId,
    ownerTeamId: input.ownerTeamId,
    organizationId: input.organizationId,
  });
  await assertValidGrantee({
    granteeTeamId: input.granteeTeamId,
    ownerTeamId: input.ownerTeamId,
    organizationId: input.organizationId,
  });

  const permission = input.permission ?? "read";

  const granteeMatch =
    input.granteeTeamId === null
      ? isNull(objectGrants.granteeTeamId)
      : eq(objectGrants.granteeTeamId, input.granteeTeamId);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: objectGrants.id })
      .from(objectGrants)
      .where(
        and(eq(objectGrants.objectTypeId, input.objectTypeId), granteeMatch),
      )
      .limit(1);
    if (existing) {
      const [updated] = await tx
        .update(objectGrants)
        .set({ permission })
        .where(eq(objectGrants.id, existing.id))
        .returning();
      return updated ?? throwHttpError(500, internalError());
    }
    const [created] = await tx
      .insert(objectGrants)
      .values({
        organizationId: input.organizationId,
        objectTypeId: input.objectTypeId,
        ownerTeamId: input.ownerTeamId,
        granteeTeamId: input.granteeTeamId,
        permission,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    return created ?? throwHttpError(500, internalError());
  });
};

/**
 * Revoke a type grant. Targets the same `(objectTypeId, granteeTeamId)` pair
 * (null grantee = the org-wide grant). No-op if nothing matches. Returns the
 * number of grants removed.
 */
export const revokeObjectType = async (input: {
  objectTypeId: string;
  granteeTeamId: string | null;
}): Promise<{ revoked: number }> => {
  const deleted = await db
    .delete(objectGrants)
    .where(
      and(
        eq(objectGrants.objectTypeId, input.objectTypeId),
        input.granteeTeamId === null
          ? isNull(objectGrants.granteeTeamId)
          : eq(objectGrants.granteeTeamId, input.granteeTeamId),
      ),
    )
    .returning({ id: objectGrants.id });
  return { revoked: deleted.length };
};
