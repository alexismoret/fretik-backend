import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../../../../db";
import {
  type CollectionPermission,
  collectionGrants,
  user,
} from "../../../../db/schema";
import { badRequest, throwHttpError } from "../../../../lib/errors";
import type { AccessLevel } from "../../../../schemas/access";
import { assertValidGrantee } from "../../../collection-sharing/validate";
import type { GrantStore, StoredGrant, StoredHolder } from "../grant-store";
import type { PrincipalRef } from "../principals";

/**
 * A collection keeps who it was shared with in `collection_grants`, which the
 * SQL tool's row-level security reads (`fretik_type_granted`) and the engine
 * maps onto its levels (`authz/resources/structure.ts`): another team, or the
 * whole organization (no grantee), reads (`read`) or edits (`write`) it. The
 * share dialog's `view` is `read`, its `edit` is `write`, and nothing else: a
 * collection is its team's, shared with other teams, never with one person.
 */

const levelOf = (permission: CollectionPermission): AccessLevel =>
  permission === "write" ? "edit" : "view";

const permissionOf = (level: AccessLevel): CollectionPermission => {
  if (level === "view") return "read";
  if (level === "edit") return "write";
  return throwHttpError(
    400,
    badRequest("A collection is shared at view or edit access."),
  );
};

/** The grantee a principal names: a team, or null for the organization. */
const granteeOf = (ref: PrincipalRef): string | null => {
  if (ref.type === "organization") return null;
  if (ref.type === "team") return ref.id;
  return throwHttpError(
    400,
    badRequest("A collection is shared with teams or the whole organization."),
  );
};

const matching = (collectionId: string, refs: readonly PrincipalRef[]) =>
  and(
    eq(collectionGrants.collectionId, collectionId),
    or(
      ...refs.map((ref) => {
        const grantee = granteeOf(ref);
        return grantee === null
          ? isNull(collectionGrants.granteeTeamId)
          : eq(collectionGrants.granteeTeamId, grantee);
      }),
    ),
  );

const principalOf = (row: {
  organizationId: string;
  granteeTeamId: string | null;
}): PrincipalRef =>
  row.granteeTeamId === null
    ? { type: "organization", id: row.organizationId }
    : { type: "team", id: row.granteeTeamId };

export const collectionGrantStore: GrantStore = {
  lock: async (tx, resource, refs): Promise<StoredGrant[]> => {
    if (refs.length === 0) return [];
    const rows = await tx
      .select({
        organizationId: collectionGrants.organizationId,
        granteeTeamId: collectionGrants.granteeTeamId,
        permission: collectionGrants.permission,
      })
      .from(collectionGrants)
      .where(matching(resource.id, refs))
      .for("update");
    // A collection is shared with teams, whose grants never end.
    return rows.map((row) => ({
      ...principalOf(row),
      level: levelOf(row.permission),
      expiresAt: null,
    }));
  },

  list: async (executor: Executor, resource): Promise<StoredHolder[]> => {
    const rows = await executor
      .select({
        organizationId: collectionGrants.organizationId,
        granteeTeamId: collectionGrants.granteeTeamId,
        permission: collectionGrants.permission,
        grantedAt: collectionGrants.createdAt,
        grantedByUserId: collectionGrants.createdByUserId,
        grantedByName: user.name,
      })
      .from(collectionGrants)
      .leftJoin(user, eq(user.id, collectionGrants.createdByUserId))
      .where(eq(collectionGrants.collectionId, resource.id));
    return rows.map((row): StoredHolder => ({
      ...principalOf(row),
      level: levelOf(row.permission),
      expiresAt: null,
      grantedAt: row.grantedAt,
      grantedBy:
        row.grantedByUserId === null || row.grantedByName === null
          ? null
          : { userId: row.grantedByUserId, name: row.grantedByName },
    }));
  },

  upsert: async (tx, write): Promise<void> => {
    if (write.refs.length === 0) return;
    const collection = await tx.query.collections.findFirst({
      columns: { teamId: true },
      where: { id: write.resource.id, organizationId: write.organizationId },
    });
    if (!collection) {
      return throwHttpError(400, badRequest("Collection not found."));
    }
    if (collection.teamId === null) {
      return throwHttpError(
        400,
        badRequest("An organization's collection is everyone's already."),
      );
    }
    const ownerTeamId = collection.teamId;
    const permission = permissionOf(write.level);
    const grantees = write.refs.map(granteeOf);
    for (const granteeTeamId of grantees) {
      // oxlint-disable-next-line no-await-in-loop -- a few picks at most
      await assertValidGrantee({
        granteeTeamId,
        ownerTeamId,
        organizationId: write.organizationId,
      });
    }
    const row = (granteeTeamId: string | null) => ({
      organizationId: write.organizationId,
      collectionId: write.resource.id,
      ownerTeamId,
      granteeTeamId,
      permission,
      createdByUserId: write.actorUserId,
    });

    const teams = grantees.filter((grantee) => grantee !== null);
    if (teams.length > 0) {
      await tx
        .insert(collectionGrants)
        .values(teams.map(row))
        .onConflictDoUpdate({
          target: [
            collectionGrants.collectionId,
            collectionGrants.granteeTeamId,
          ],
          targetWhere: sql`grantee_team_id IS NOT NULL`,
          set: { permission },
        });
    }
    if (grantees.includes(null)) {
      await tx
        .insert(collectionGrants)
        .values(row(null))
        .onConflictDoUpdate({
          target: [collectionGrants.collectionId],
          targetWhere: sql`grantee_team_id IS NULL`,
          set: { permission },
        });
    }
  },

  remove: async (tx, resource, refs): Promise<void> => {
    if (refs.length === 0) return;
    await tx.delete(collectionGrants).where(matching(resource.id, refs));
  },
};
