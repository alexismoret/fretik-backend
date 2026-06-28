import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { ObjectPermission, RecordShare } from "../../db/schema";
import { recordShares } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { assertSharableRecord, assertValidGrantee } from "./validate";

/**
 * Share a single record with another team (or org-wide when `granteeTeamId` is
 * null) — finer than a type grant. Idempotent on `(recordId, granteeTeamId)`:
 * re-sharing updates the permission. The RLS helper `fretik_record_shared`
 * reads these rows, so the one record becomes visible to the grantee.
 */
export const shareRecord = async (input: {
  organizationId: string;
  recordId: string;
  ownerTeamId: string;
  granteeTeamId: string | null;
  permission?: ObjectPermission;
  createdByUserId?: string | null;
}): Promise<RecordShare> => {
  await assertSharableRecord({
    recordId: input.recordId,
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
      ? isNull(recordShares.granteeTeamId)
      : eq(recordShares.granteeTeamId, input.granteeTeamId);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: recordShares.id })
      .from(recordShares)
      .where(and(eq(recordShares.recordId, input.recordId), granteeMatch))
      .limit(1);
    if (existing) {
      const [updated] = await tx
        .update(recordShares)
        .set({ permission })
        .where(eq(recordShares.id, existing.id))
        .returning();
      return updated ?? throwHttpError(500, internalError());
    }
    const [created] = await tx
      .insert(recordShares)
      .values({
        organizationId: input.organizationId,
        recordId: input.recordId,
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
 * Unshare a record. Targets the same `(recordId, granteeTeamId)` pair (null
 * grantee = the org-wide share). No-op if nothing matches. Returns the number
 * of shares removed.
 */
export const unshareRecord = async (input: {
  recordId: string;
  granteeTeamId: string | null;
}): Promise<{ revoked: number }> => {
  const deleted = await db
    .delete(recordShares)
    .where(
      and(
        eq(recordShares.recordId, input.recordId),
        input.granteeTeamId === null
          ? isNull(recordShares.granteeTeamId)
          : eq(recordShares.granteeTeamId, input.granteeTeamId),
      ),
    )
    .returning({ id: recordShares.id });
  return { revoked: deleted.length };
};
