import { type SQL, and, eq, exists, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import {
  objectGrants,
  objectRecords,
  objectTypes,
  recordShares,
} from "../../db/schema";

/**
 * Read-side authorization predicates for cross-team sharing — the service-layer
 * mirror of the RLS policies (`fretik_type_granted` / `fretik_record_shared`).
 * The API read services run on the owner DB connection (RLS bypassed), so they
 * must apply these predicates themselves to honour grants without leaking other
 * teams' data.
 *
 * A team sees a subject when it owns it, when its TYPE is granted to the team
 * (or org-wide), or when the specific RECORD is shared to the team (or org-wide).
 */

/** Whether `teamId` has a type-level grant on `objectTypeId` (team or org-wide). */
export const teamHasTypeGrant = async (input: {
  objectTypeId: string;
  teamId: string;
  organizationId: string;
}): Promise<boolean> => {
  const [row] = await db
    .select({ one: sql`1` })
    .from(objectGrants)
    .where(
      and(
        eq(objectGrants.objectTypeId, input.objectTypeId),
        eq(objectGrants.organizationId, input.organizationId),
        or(
          eq(objectGrants.granteeTeamId, input.teamId),
          isNull(objectGrants.granteeTeamId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * Correlated `EXISTS` for the object-types list: the current `object_types` row
 * is granted to `teamId` (team grant or org-wide). Pair with the own/system arms
 * in `listObjectTypes`.
 */
export const typeGrantedExists = (
  teamId: string,
  organizationId: string,
): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(objectGrants)
      .where(
        and(
          eq(objectGrants.objectTypeId, objectTypes.id),
          eq(objectGrants.organizationId, organizationId),
          or(
            eq(objectGrants.granteeTeamId, teamId),
            isNull(objectGrants.granteeTeamId),
          ),
        ),
      ),
  );

/**
 * Correlated `EXISTS` for the records list: the current `object_records` row is
 * shared to `teamId` (record share or org-wide). Pair with the owner arm in
 * `listObjectRecords`.
 */
export const recordSharedExists = (
  teamId: string,
  organizationId: string,
): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(recordShares)
      .where(
        and(
          eq(recordShares.recordId, objectRecords.id),
          eq(recordShares.organizationId, organizationId),
          or(
            eq(recordShares.granteeTeamId, teamId),
            isNull(recordShares.granteeTeamId),
          ),
        ),
      ),
  );
