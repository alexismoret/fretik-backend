import { and, eq, isNull, ne, or } from "drizzle-orm";
import db from "../../db";
import type { CollectionPermission } from "../../db/schema";
import {
  collectionGrants,
  collectionRecords,
  recordShares,
  team,
} from "../../db/schema";

/**
 * Read side of the sharing layer: who a type/record is shared WITH (for the
 * owner's sharing control) and what is shared WITH a team (for the "Shared with
 * me" filter + badges). An org-wide grant is surfaced as `granteeTeamId: null`.
 */

export type GranteeEntry = {
  id: string;
  granteeTeamId: string | null;
  granteeTeamName: string | null;
  permission: CollectionPermission;
};

/** Grants on a type, with grantee team names (null = org-wide). Owner's view. */
export const listTypeGrants = async (
  collectionId: string,
): Promise<GranteeEntry[]> =>
  db
    .select({
      id: collectionGrants.id,
      granteeTeamId: collectionGrants.granteeTeamId,
      granteeTeamName: team.name,
      permission: collectionGrants.permission,
    })
    .from(collectionGrants)
    .leftJoin(team, eq(team.id, collectionGrants.granteeTeamId))
    .where(eq(collectionGrants.collectionId, collectionId));

/** Shares on a record, with grantee team names (null = org-wide). Owner's view. */
export const listRecordShares = async (
  recordId: string,
): Promise<GranteeEntry[]> =>
  db
    .select({
      id: recordShares.id,
      granteeTeamId: recordShares.granteeTeamId,
      granteeTeamName: team.name,
      permission: recordShares.permission,
    })
    .from(recordShares)
    .leftJoin(team, eq(team.id, recordShares.granteeTeamId))
    .where(eq(recordShares.recordId, recordId));

/**
 * Sharing state of a team's collections, in two sets for the index page:
 *   - `sharedOut` — type ids the team OWNS and has shared with anyone (badge
 *     "Shared").
 *   - `sharedWithMe` — type ids OWNED BY OTHER TEAMS that are visible to this
 *     team via a grant (grantee = team, or org-wide). Drives the "Shared with
 *     me" filter + badge.
 */
export const listSharedTypeIds = async (input: {
  organizationId: string;
  teamId: string;
}): Promise<{ sharedOut: string[]; sharedWithMe: string[] }> => {
  const [sharedOutRows, sharedWithMeRows] = await Promise.all([
    db
      .selectDistinct({ collectionId: collectionGrants.collectionId })
      .from(collectionGrants)
      .where(eq(collectionGrants.ownerTeamId, input.teamId)),
    db
      .selectDistinct({ collectionId: collectionGrants.collectionId })
      .from(collectionGrants)
      .where(
        and(
          eq(collectionGrants.organizationId, input.organizationId),
          ne(collectionGrants.ownerTeamId, input.teamId),
          or(
            eq(collectionGrants.granteeTeamId, input.teamId),
            isNull(collectionGrants.granteeTeamId),
          ),
        ),
      ),
  ]);
  return {
    sharedOut: sharedOutRows.map((r) => r.collectionId),
    sharedWithMe: sharedWithMeRows.map((r) => r.collectionId),
  };
};

/**
 * Record ids of one type that the team has shared out (record-level), for the
 * shared/private badge on the record list. Owner's view of a single type.
 */
export const listSharedRecordIdsForType = async (input: {
  teamId: string;
  collectionId: string;
}): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ recordId: recordShares.recordId })
    .from(recordShares)
    .innerJoin(
      collectionRecords,
      eq(collectionRecords.id, recordShares.recordId),
    )
    .where(
      and(
        eq(recordShares.ownerTeamId, input.teamId),
        eq(collectionRecords.collectionId, input.collectionId),
      ),
    );
  return rows.map((r) => r.recordId);
};
