import { eq, type SQL } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";
import { recordSharedExists, teamHasTypeGrant } from "../object-sharing/access";

/**
 * Row-visibility scope for a type's records, shared by the list and aggregate
 * queries so both enforce the SAME RLS-mirroring rules (a divergence here is a
 * data-leak). A type's records live under its OWNER team: an own/system type →
 * the viewer's rows; a foreign type covered by a type-grant → all its rows;
 * otherwise → only the records individually shared with the viewing team.
 */
export interface RecordTypeScope {
  /** Team that owns the type's field defs (own type → viewer; foreign → owner). */
  ownerTeamId: string;
  organizationId: string | undefined;
  isForeign: boolean;
  hasTypeGrant: boolean;
}

export const resolveRecordTypeScope = async (data: {
  objectTypeId: string;
  teamId: string;
}): Promise<RecordTypeScope> => {
  const type = await db.query.objectTypes.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: data.objectTypeId },
  });
  const ownerTeamId = type?.teamId ?? data.teamId;
  const organizationId = type?.organizationId;
  const isForeign = type?.teamId != null && type.teamId !== data.teamId;
  const hasTypeGrant =
    isForeign && organizationId !== undefined
      ? await teamHasTypeGrant({
          objectTypeId: data.objectTypeId,
          teamId: data.teamId,
          organizationId,
        })
      : false;
  return { ownerTeamId, organizationId, isForeign, hasTypeGrant };
};

/**
 * The `WHERE` predicate that scopes `object_records` rows to what the viewing
 * team may see. `undefined` for a grant-covered foreign type (every row of the
 * type is visible, so no extra predicate).
 */
export const recordVisibilityCondition = (data: {
  teamId: string;
  scope: RecordTypeScope;
}): SQL | undefined => {
  const { teamId, scope } = data;
  if (!scope.isForeign) return eq(objectRecords.teamId, teamId);
  if (!scope.hasTypeGrant && scope.organizationId !== undefined) {
    return recordSharedExists(teamId, scope.organizationId);
  }
  return undefined;
};
