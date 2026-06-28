import { inArray } from "drizzle-orm";
import db from "../../db";
import { domainEvents, objectRecords } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";

/**
 * Result of a bulk delete. `deletedIds` are the records actually removed (owned
 * by the team and present); `errors` carries the ids that were skipped because
 * they are missing or belong to another team.
 */
export interface BulkDeleteResult {
  deletedIds: string[];
  errors: { id: string; error: string }[];
}

/**
 * Delete MANY records owned by `teamId` in a batch. The bulk sibling of
 * `deleteObjectRecord`: same `record.deleted` journal entry per record, same FK
 * cascade (extension row, links, event-link provenance), but set-based — one
 * `INSERT` of the events and one `DELETE` per chunk, never a query per row.
 *
 * Tenancy is enforced HERE: only rows whose `owner_team_id` is `teamId` are
 * touched; any other id (other teams, made-up ids) is returned in `errors`. A
 * caller never needs a separate ownership pre-check.
 */
export const bulkDeleteObjectRecords = async (input: {
  teamId: string;
  ids: string[];
  actor?: EventActor;
}): Promise<BulkDeleteResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const requestedIds = [...new Set(input.ids)];
  if (requestedIds.length === 0) return { deletedIds: [], errors: [] };

  // Fetch the owned rows once (chunked SELECTs keep the IN-list bounded). The
  // event payload keeps id + label so the deletion stays auditable after the
  // row is gone (the cascade nulls `subject_record_id`).
  const owned: {
    id: string;
    organizationId: string;
    teamId: string;
    label: string;
  }[] = [];
  for (const idChunk of chunkForBulk(requestedIds)) {
    const rows = await db
      .select({
        id: objectRecords.id,
        organizationId: objectRecords.organizationId,
        teamId: objectRecords.teamId,
        label: objectRecords.label,
      })
      .from(objectRecords)
      .where(inArray(objectRecords.id, idChunk));
    for (const r of rows) if (r.teamId === input.teamId) owned.push(r);
  }

  const ownedSet = new Set(owned.map((r) => r.id));
  const errors = requestedIds
    .filter((id) => !ownedSet.has(id))
    .map((id) => ({ id, error: "Record not found in your team." }));

  const deletedIds: string[] = [];
  for (const batch of chunkForBulk(owned)) {
    await db.transaction(async (tx) => {
      await tx.insert(domainEvents).values(
        batch.map((r) => ({
          organizationId: r.organizationId,
          teamId: r.teamId,
          type: "record.deleted",
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          conversationId: actor.conversationId ?? null,
          payload: { recordId: r.id, label: r.label },
        })),
      );
      await tx.delete(objectRecords).where(
        inArray(
          objectRecords.id,
          batch.map((r) => r.id),
        ),
      );
    });
    for (const r of batch) deletedIds.push(r.id);
  }

  return { deletedIds, errors };
};
