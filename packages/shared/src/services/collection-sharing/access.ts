import { type SQL, and, eq, exists, isNull, or, sql } from "drizzle-orm";
import db from "../../db";
import {
  collectionGrants,
  collectionRecords,
  collections,
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

/** Whether `teamId` has a type-level grant on `collectionId` (team or org-wide). */
export const teamHasTypeGrant = async (input: {
  collectionId: string;
  teamId: string;
  organizationId: string;
}): Promise<boolean> => {
  const [row] = await db
    .select({ one: sql`1` })
    .from(collectionGrants)
    .where(
      and(
        eq(collectionGrants.collectionId, input.collectionId),
        eq(collectionGrants.organizationId, input.organizationId),
        or(
          eq(collectionGrants.granteeTeamId, input.teamId),
          isNull(collectionGrants.granteeTeamId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * Correlated `EXISTS` for the collections list: the current `collections` row
 * is granted to `teamId` (team grant or org-wide). Pair with the own/system arms
 * in `listCollections`.
 */
export const typeGrantedExists = (
  teamId: string,
  organizationId: string,
): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(collectionGrants)
      .where(
        and(
          eq(collectionGrants.collectionId, collections.id),
          eq(collectionGrants.organizationId, organizationId),
          or(
            eq(collectionGrants.granteeTeamId, teamId),
            isNull(collectionGrants.granteeTeamId),
          ),
        ),
      ),
  );

/**
 * Correlated `EXISTS` for record reads: the TYPE of the current
 * `collection_records` row is granted to `teamId` (team grant or org-wide).
 * The record-side twin of `typeGrantedExists` — `fretik_type_granted` applied
 * through `collection_records.collection_id`.
 */
export const recordTypeGrantedExists = (
  teamId: string,
  organizationId: string,
): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(collectionGrants)
      .where(
        and(
          eq(collectionGrants.collectionId, collectionRecords.collectionId),
          eq(collectionGrants.organizationId, organizationId),
          or(
            eq(collectionGrants.granteeTeamId, teamId),
            isNull(collectionGrants.granteeTeamId),
          ),
        ),
      ),
  );

/**
 * Correlated `EXISTS` for the records list: the current `collection_records` row is
 * shared to `teamId` (record share or org-wide). Pair with the owner arm in
 * `listCollectionRecords`.
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
          eq(recordShares.recordId, collectionRecords.id),
          eq(recordShares.organizationId, organizationId),
          or(
            eq(recordShares.granteeTeamId, teamId),
            isNull(recordShares.granteeTeamId),
          ),
        ),
      ),
  );

/**
 * Whether `teamId` may READ the current `collection_records` row — the full
 * service-layer mirror of `_team_id = fretik_team() OR fretik_record_visible(id)`:
 * the owning team, a type grant while the record still inherits its type's
 * sharing, or a share on the record itself. Pinned to `organizationId` first,
 * so no grant or share can ever reach across organizations.
 */
export const recordReadableCondition = (
  teamId: string,
  organizationId: string,
): SQL =>
  and(
    eq(collectionRecords.organizationId, organizationId),
    or(
      eq(collectionRecords.teamId, teamId),
      and(
        eq(collectionRecords.inheritTypeSharing, true),
        recordTypeGrantedExists(teamId, organizationId),
      ),
      recordSharedExists(teamId, organizationId),
    ),
  ) as SQL;

/**
 * Whether `teamId` may READ the current `collections` row: an org-level type,
 * its own, one granted to it, or one it holds at least one shared record of
 * (the record drawer needs the type's fields to render a shared record).
 * Pinned to `organizationId` like the record predicate.
 */
export const collectionReadableCondition = (
  teamId: string,
  organizationId: string,
): SQL =>
  and(
    eq(collections.organizationId, organizationId),
    or(
      isNull(collections.teamId),
      eq(collections.teamId, teamId),
      typeGrantedExists(teamId, organizationId),
      exists(
        db
          .select({ one: sql`1` })
          .from(recordShares)
          .innerJoin(
            collectionRecords,
            eq(collectionRecords.id, recordShares.recordId),
          )
          .where(
            and(
              eq(collectionRecords.collectionId, collections.id),
              eq(recordShares.organizationId, organizationId),
              or(
                eq(recordShares.granteeTeamId, teamId),
                isNull(recordShares.granteeTeamId),
              ),
            ),
          ),
      ),
    ),
  ) as SQL;
