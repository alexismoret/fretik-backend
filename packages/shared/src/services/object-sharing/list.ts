import { and, eq, isNull, ne, or } from "drizzle-orm";
import db from "../../db";
import type { ObjectPermission } from "../../db/schema";
import {
  objectGrants,
  objectRecords,
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
  permission: ObjectPermission;
};

/** Grants on a type, with grantee team names (null = org-wide). Owner's view. */
export const listTypeGrants = async (
  objectTypeId: string,
): Promise<GranteeEntry[]> =>
  db
    .select({
      id: objectGrants.id,
      granteeTeamId: objectGrants.granteeTeamId,
      granteeTeamName: team.name,
      permission: objectGrants.permission,
    })
    .from(objectGrants)
    .leftJoin(team, eq(team.id, objectGrants.granteeTeamId))
    .where(eq(objectGrants.objectTypeId, objectTypeId));

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
 * Sharing state of a team's object types, in two sets for the index page:
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
      .selectDistinct({ objectTypeId: objectGrants.objectTypeId })
      .from(objectGrants)
      .where(eq(objectGrants.ownerTeamId, input.teamId)),
    db
      .selectDistinct({ objectTypeId: objectGrants.objectTypeId })
      .from(objectGrants)
      .where(
        and(
          eq(objectGrants.organizationId, input.organizationId),
          ne(objectGrants.ownerTeamId, input.teamId),
          or(
            eq(objectGrants.granteeTeamId, input.teamId),
            isNull(objectGrants.granteeTeamId),
          ),
        ),
      ),
  ]);
  return {
    sharedOut: sharedOutRows.map((r) => r.objectTypeId),
    sharedWithMe: sharedWithMeRows.map((r) => r.objectTypeId),
  };
};

/**
 * Record ids of one type that the team has shared out (record-level), for the
 * shared/private badge on the record list. Owner's view of a single type.
 */
export const listSharedRecordIdsForType = async (input: {
  teamId: string;
  objectTypeId: string;
}): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ recordId: recordShares.recordId })
    .from(recordShares)
    .innerJoin(objectRecords, eq(objectRecords.id, recordShares.recordId))
    .where(
      and(
        eq(recordShares.ownerTeamId, input.teamId),
        eq(objectRecords.objectTypeId, input.objectTypeId),
      ),
    );
  return rows.map((r) => r.recordId);
};
