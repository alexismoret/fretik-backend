// oxlint-disable no-await-in-loop
import { and, eq, isNull, or } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { collections } from "../../db/schema";
import { recomputeSearchVectorsForType } from "../collection-records/field-data";
import { reconcileCollectionTable } from "./table";

/**
 * Catalog → physical sync. The single hook the object-type / field-definition
 * services call after a catalog change to keep the per-type extension tables in
 * step with the field definitions. The DDL itself lives in `table.ts`; this
 * composes it with the search-vector recompute and the team-wide fan-out. No
 * views anywhere — the chatbot reads the real tables + registry directly.
 */

/**
 * Reconcile a type's extension table after a field change, then refresh the
 * affected team's search vectors. `teamId` null = an org-template change (no
 * team records to revector); the table is still reconciled (its columns are the
 * union across teams).
 */
export const refreshCollectionTableAfterCatalogChange = async (input: {
  organizationId: string;
  collectionId: string;
  teamId: string | null;
  tx?: Transaction;
}): Promise<void> => {
  await reconcileCollectionTable({
    collectionId: input.collectionId,
    tx: input.tx,
  });
  if (input.teamId) {
    await recomputeSearchVectorsForType({
      organizationId: input.organizationId,
      collectionId: input.collectionId,
      teamId: input.teamId,
      tx: input.tx,
    });
  }
};

/**
 * Reconcile the extension table of every type a team can see (its own +
 * org/system). Used at team creation and by the backfill script. Returns the
 * number of types synced.
 */
export const syncAllCollectionTablesForTeam = async (input: {
  organizationId: string;
  teamId: string;
  tx?: Transaction;
}): Promise<number> => {
  const exec = input.tx ?? db;
  const types = await exec
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.organizationId, input.organizationId),
        or(eq(collections.teamId, input.teamId), isNull(collections.teamId)),
      ),
    );
  for (const type of types) {
    await reconcileCollectionTable({ collectionId: type.id, tx: input.tx });
  }
  return types.length;
};
