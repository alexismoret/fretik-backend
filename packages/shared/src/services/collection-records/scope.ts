import { and, eq, or, type SQL, sql } from "drizzle-orm";
import {
  type DriveVisibility,
  mirrorRecordVisible,
} from "../../authz/drive-sql";
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
 *
 * Everything is measured from the VIEWER's organization — the organization of
 * the viewing team, never the type's. A type of another organization is not a
 * "foreign type" with grants to consult: its grants and shares live in the
 * other organization, where an org-wide one (`grantee_team_id IS NULL`) would
 * otherwise match every team on the platform. It is simply invisible.
 */
export type RecordTypeScope =
  /** Missing, or in another organization: no row is visible. */
  | { access: "none"; ownerTeamId: string }
  /** The viewer's own type, or an org-level one: the viewer's rows. */
  | { access: "own"; ownerTeamId: string }
  /** Another team's type in the organization: grants and shares decide. */
  | {
      access: "foreign";
      /** The type's team — its field definitions render the records. */
      ownerTeamId: string;
      organizationId: string;
      hasTypeGrant: boolean;
    };

export const resolveRecordTypeScope = async (data: {
  collectionId: string;
  teamId: string;
}): Promise<RecordTypeScope> => {
  const [type, viewer] = await Promise.all([
    db.query.collections.findFirst({
      columns: { teamId: true, organizationId: true },
      where: { id: data.collectionId },
    }),
    db.query.team.findFirst({
      columns: { organizationId: true },
      where: { id: data.teamId },
    }),
  ]);

  if (!type || !viewer || type.organizationId !== viewer.organizationId) {
    return { access: "none", ownerTeamId: data.teamId };
  }
  if (type.teamId === null || type.teamId === data.teamId) {
    return { access: "own", ownerTeamId: data.teamId };
  }
  return {
    access: "foreign",
    ownerTeamId: type.teamId,
    organizationId: viewer.organizationId,
    hasTypeGrant: await teamHasTypeGrant({
      collectionId: data.collectionId,
      teamId: data.teamId,
      organizationId: viewer.organizationId,
    }),
  };
};

/**
 * The `WHERE` predicate that scopes `collection_records` rows to what the viewing
 * team may see — the service-layer mirror of the `fretik_record_visible` RLS
 * helper. A foreign type covered by a grant exposes its records only while each
 * record INHERITS the type's sharing (`inherit_type_sharing = true`); a custom
 * record (inherit=false) is visible solely via its own share. So even with a
 * type grant the predicate is `inherit OR shared`, never unconditional.
 *
 * Always a predicate: an invisible type yields `false`, never "no filter".
 *
 * And never the mirror of a document the PERSON cannot open (`drive`): the
 * team reads its records; a restricted file's name and fields stay with the
 * people it is shared with.
 */
export const recordVisibilityCondition = (data: {
  teamId: string;
  scope: RecordTypeScope;
  drive: DriveVisibility;
}): SQL =>
  and(
    teamRecordCondition(data),
    mirrorRecordVisible(data.drive, collectionRecords.documentId),
  ) ?? sql`false`;

const teamRecordCondition = (data: {
  teamId: string;
  scope: RecordTypeScope;
}): SQL => {
  const { teamId, scope } = data;
  switch (scope.access) {
    case "none":
      return sql`false`;
    case "own":
      return eq(collectionRecords.teamId, teamId);
    case "foreign": {
      const shared = recordSharedExists(teamId, scope.organizationId);
      if (!scope.hasTypeGrant) return shared;
      return (
        or(eq(collectionRecords.inheritTypeSharing, true), shared) ?? shared
      );
    }
  }
};
