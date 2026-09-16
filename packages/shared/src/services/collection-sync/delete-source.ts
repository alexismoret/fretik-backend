import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { collectionSyncSources, fieldDefinitions } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { invalidateFieldDefinitionsCache } from "../field-definitions/cache";

/**
 * Stop syncing, keep everything.
 *
 * Removing a source is an answer to "I no longer want this app writing here",
 * never to "delete what it wrote" — Airtable and Coda both keep the rows when a
 * sync is removed, and so does this, for a stronger reason: our records carry
 * LOCAL columns, links, approvals and page datasets the app never knew about.
 * So the delete releases rather than destroys:
 *
 *  - the columns become ordinary local fields, data intact and editable from
 *    that moment (the `field_definitions.sync_source_id` FK is `ON DELETE SET
 *    NULL` and would do this by itself; it is written explicitly so the cache
 *    invalidation below has something to be in step with);
 *  - the records keep their values and lose their provenance —
 *    `collection_records.sync_source_id` is a SOFT reference with no FK, so
 *    nothing in the database would clear it and a later source reusing the id
 *    space would inherit rows it never wrote;
 *  - `record_sync_state` and `collection_sync_runs` cascade away with the row:
 *    both are ABOUT the source, and without it they describe nothing.
 */
export const deleteSyncSource = async (params: {
  id: string;
  teamId: string;
  organizationId: string;
}): Promise<void> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: params.id, teamId: params.teamId },
    columns: { id: true, kind: true },
  });
  if (source === undefined) {
    return throwHttpError(404, notFound("Sync source not found"));
  }

  await db
    .update(fieldDefinitions)
    .set({ syncSourceId: null })
    .where(eq(fieldDefinitions.syncSourceId, source.id));

  if (source.kind === "table") {
    await db.execute(sql`
      UPDATE collection_records
         SET sync_source_id = NULL, external_id = NULL
       WHERE sync_source_id = ${source.id}::uuid`);
  }

  await db
    .delete(collectionSyncSources)
    .where(eq(collectionSyncSources.id, source.id));

  await invalidateFieldDefinitionsCache({
    organizationId: params.organizationId,
    teamId: params.teamId,
  });
};
