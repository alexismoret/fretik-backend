import { eq, inArray } from "drizzle-orm";
import db, { type Executor } from "../../db";
import type { ObjectPermission } from "../../db/schema";
import { objectGrants, objectRecords, recordShares } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import type { Audience, RecordSharing } from "../../schemas/object-sharing";
import { assertValidGrantee } from "./validate";

/**
 * Sharing reconciliation — the single write path that turns an `Audience`
 * descriptor into the right set of `object_grants` / `record_shares` rows, in the
 * caller's transaction. Every surface (REST routes, AI tools, Python SDK) passes
 * the SAME descriptor through the create/update services, which call these
 * functions; there is no second sharing-write path.
 *
 * A reconcile is a full diff against the desired set: rows whose grantee is no
 * longer wanted are deleted, new grantees inserted, and changed permissions
 * updated. So passing `internal` clears all sharing, and editing the team list is
 * just another reconcile.
 */

/** The desired grantee→permission set for an audience (`null` key = org-wide). */
const audienceGrantees = (
  audience: Audience,
): Map<string | null, ObjectPermission> => {
  const desired = new Map<string | null, ObjectPermission>();
  if (audience.mode === "org") desired.set(null, audience.permission);
  else if (audience.mode === "teams") {
    for (const t of audience.teams) desired.set(t.teamId, t.permission);
  }
  return desired;
};

/**
 * Reconcile an object type's grants to match `audience`. Validates every team
 * grantee belongs to the org and is not the owner. Owner-eligibility (only the
 * owning team may share) is asserted at the API/tool boundary before this runs.
 */
export const reconcileTypeGrants = async (input: {
  objectTypeId: string;
  ownerTeamId: string;
  organizationId: string;
  audience: Audience;
  createdByUserId?: string | null;
  tx: Executor;
}): Promise<void> => {
  const { tx } = input;
  const desired = audienceGrantees(input.audience);
  for (const granteeTeamId of desired.keys()) {
    await assertValidGrantee({
      granteeTeamId,
      ownerTeamId: input.ownerTeamId,
      organizationId: input.organizationId,
    });
  }

  const existing = await tx
    .select({
      id: objectGrants.id,
      granteeTeamId: objectGrants.granteeTeamId,
      permission: objectGrants.permission,
    })
    .from(objectGrants)
    .where(eq(objectGrants.objectTypeId, input.objectTypeId));

  const seen = new Set<string | null>();
  const staleIds: string[] = [];
  for (const row of existing) {
    if (!desired.has(row.granteeTeamId)) {
      staleIds.push(row.id);
      continue;
    }
    seen.add(row.granteeTeamId);
    const wanted = desired.get(row.granteeTeamId);
    if (wanted !== undefined && wanted !== row.permission) {
      await tx
        .update(objectGrants)
        .set({ permission: wanted })
        .where(eq(objectGrants.id, row.id));
    }
  }
  if (staleIds.length > 0) {
    await tx.delete(objectGrants).where(inArray(objectGrants.id, staleIds));
  }

  const toInsert = [...desired.entries()]
    .filter(([granteeTeamId]) => !seen.has(granteeTeamId))
    .map(([granteeTeamId, permission]) => ({
      organizationId: input.organizationId,
      objectTypeId: input.objectTypeId,
      ownerTeamId: input.ownerTeamId,
      granteeTeamId,
      permission,
      createdByUserId: input.createdByUserId ?? null,
    }));
  if (toInsert.length > 0) await tx.insert(objectGrants).values(toInsert);
};

/** The type's effective access set, used to bound a record's custom audience. */
interface TypeAccess {
  orgVisible: boolean; // org/system type, or an org-wide grant exists
  grantedTeamIds: Set<string>;
}

const loadTypeAccess = async (input: {
  objectTypeId: string;
  organizationId: string;
  tx: Executor;
}): Promise<TypeAccess> => {
  const type = await input.tx.query.objectTypes.findFirst({
    columns: { teamId: true },
    where: { id: input.objectTypeId },
  });
  const grants = await input.tx
    .select({ granteeTeamId: objectGrants.granteeTeamId })
    .from(objectGrants)
    .where(eq(objectGrants.objectTypeId, input.objectTypeId));
  const grantedTeamIds = new Set<string>();
  let orgWide = false;
  for (const g of grants) {
    if (g.granteeTeamId === null) orgWide = true;
    else grantedTeamIds.add(g.granteeTeamId);
  }
  return { orgVisible: type?.teamId == null || orgWide, grantedTeamIds };
};

/**
 * Reconcile a single record's sharing. `inherit:true` clears the record's own
 * shares and re-follows the type; `inherit:false` gives it a custom audience,
 * validated as a subset of the type's access (a record can only be shared with
 * teams that already have access to its type — an org-wide record share needs an
 * org-wide / org-system type).
 */
export const reconcileRecordShares = async (input: {
  recordId: string;
  ownerTeamId: string;
  organizationId: string;
  objectTypeId: string;
  sharing: RecordSharing;
  createdByUserId?: string | null;
  tx: Executor;
}): Promise<void> => {
  const { tx } = input;

  if (input.sharing.inherit) {
    await tx
      .update(objectRecords)
      .set({ inheritTypeSharing: true })
      .where(eq(objectRecords.id, input.recordId));
    await tx
      .delete(recordShares)
      .where(eq(recordShares.recordId, input.recordId));
    return;
  }

  const desired = audienceGrantees(input.sharing.audience);
  const access = await loadTypeAccess({
    objectTypeId: input.objectTypeId,
    organizationId: input.organizationId,
    tx,
  });
  for (const granteeTeamId of desired.keys()) {
    await assertValidGrantee({
      granteeTeamId,
      ownerTeamId: input.ownerTeamId,
      organizationId: input.organizationId,
    });
    const hasAccess =
      access.orgVisible ||
      (granteeTeamId !== null && access.grantedTeamIds.has(granteeTeamId));
    if (!hasAccess) {
      return throwHttpError(
        400,
        badRequest(
          "A record can only be shared with teams that have access to its type",
        ),
      );
    }
  }

  await tx
    .update(objectRecords)
    .set({ inheritTypeSharing: false })
    .where(eq(objectRecords.id, input.recordId));

  const existing = await tx
    .select({
      id: recordShares.id,
      granteeTeamId: recordShares.granteeTeamId,
      permission: recordShares.permission,
    })
    .from(recordShares)
    .where(eq(recordShares.recordId, input.recordId));

  const seen = new Set<string | null>();
  const staleIds: string[] = [];
  for (const row of existing) {
    if (!desired.has(row.granteeTeamId)) {
      staleIds.push(row.id);
      continue;
    }
    seen.add(row.granteeTeamId);
    const wanted = desired.get(row.granteeTeamId);
    if (wanted !== undefined && wanted !== row.permission) {
      await tx
        .update(recordShares)
        .set({ permission: wanted })
        .where(eq(recordShares.id, row.id));
    }
  }
  if (staleIds.length > 0) {
    await tx.delete(recordShares).where(inArray(recordShares.id, staleIds));
  }

  const toInsert = [...desired.entries()]
    .filter(([granteeTeamId]) => !seen.has(granteeTeamId))
    .map(([granteeTeamId, permission]) => ({
      organizationId: input.organizationId,
      recordId: input.recordId,
      ownerTeamId: input.ownerTeamId,
      granteeTeamId,
      permission,
      createdByUserId: input.createdByUserId ?? null,
    }));
  if (toInsert.length > 0) await tx.insert(recordShares).values(toInsert);
};

/**
 * Read a type's current audience as an `Audience` descriptor — the inverse of
 * `reconcileTypeGrants`, for the API/UI to display and to seed a record's
 * "same as type" default. Uses the default executor (owner connection).
 */
export const readTypeAudience = async (input: {
  objectTypeId: string;
}): Promise<Audience> => {
  const grants = await db
    .select({
      granteeTeamId: objectGrants.granteeTeamId,
      permission: objectGrants.permission,
    })
    .from(objectGrants)
    .where(eq(objectGrants.objectTypeId, input.objectTypeId));
  const orgWide = grants.find((g) => g.granteeTeamId === null);
  if (orgWide) return { mode: "org", permission: orgWide.permission };
  const teams = grants
    .filter(
      (g): g is { granteeTeamId: string; permission: ObjectPermission } =>
        g.granteeTeamId !== null,
    )
    .map((g) => ({ teamId: g.granteeTeamId, permission: g.permission }));
  if (teams.length > 0) return { mode: "teams", teams };
  return { mode: "internal" };
};
