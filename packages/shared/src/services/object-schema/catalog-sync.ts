// oxlint-disable no-await-in-loop
import { and, eq, isNull, or } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { objectTypes } from "../../db/schema";
import { recomputeSearchVectorsForType } from "../object-records/field-data";
import { reconcileObjectTable } from "./table";

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
export const refreshObjectTableAfterCatalogChange = async (input: {
  organizationId: string;
  objectTypeId: string;
  teamId: string | null;
  tx?: Transaction;
}): Promise<void> => {
  await reconcileObjectTable({
    objectTypeId: input.objectTypeId,
    tx: input.tx,
  });
  if (input.teamId) {
    await recomputeSearchVectorsForType({
      organizationId: input.organizationId,
      objectTypeId: input.objectTypeId,
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
export const syncAllObjectTablesForTeam = async (input: {
  organizationId: string;
  teamId: string;
  tx?: Transaction;
}): Promise<number> => {
  const exec = input.tx ?? db;
  const types = await exec
    .select({ id: objectTypes.id })
    .from(objectTypes)
    .where(
      and(
        eq(objectTypes.organizationId, input.organizationId),
        or(eq(objectTypes.teamId, input.teamId), isNull(objectTypes.teamId)),
      ),
    );
  for (const type of types) {
    await reconcileObjectTable({ objectTypeId: type.id, tx: input.tx });
  }
  return types.length;
};
