import { eq, or, type SQL } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import {
  recordSharedExists,
  teamHasTypeGrant,
} from "../collection-sharing/access";

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
  collectionId: string;
  teamId: string;
}): Promise<RecordTypeScope> => {
  const type = await db.query.collections.findFirst({
    columns: { teamId: true, organizationId: true },
    where: { id: data.collectionId },
  });
  const ownerTeamId = type?.teamId ?? data.teamId;
  const organizationId = type?.organizationId;
  const isForeign = type?.teamId != null && type.teamId !== data.teamId;
  const hasTypeGrant =
    isForeign && organizationId !== undefined
      ? await teamHasTypeGrant({
          collectionId: data.collectionId,
          teamId: data.teamId,
          organizationId,
        })
      : false;
  return { ownerTeamId, organizationId, isForeign, hasTypeGrant };
};

/**
 * The `WHERE` predicate that scopes `collection_records` rows to what the viewing
 * team may see — the service-layer mirror of the `fretik_record_visible` RLS
 * helper. A foreign type covered by a grant exposes its records only while each
 * record INHERITS the type's sharing (`inherit_type_sharing = true`); a custom
 * record (inherit=false) is visible solely via its own share. So even with a
 * type grant the predicate is `inherit OR shared`, never unconditional.
 */
export const recordVisibilityCondition = (data: {
  teamId: string;
  scope: RecordTypeScope;
}): SQL | undefined => {
  const { teamId, scope } = data;
  if (!scope.isForeign) return eq(collectionRecords.teamId, teamId);
  if (scope.organizationId === undefined) return undefined;
  const shared = recordSharedExists(teamId, scope.organizationId);
  if (scope.hasTypeGrant) {
    return or(eq(collectionRecords.inheritTypeSharing, true), shared);
  }
  return shared;
};
