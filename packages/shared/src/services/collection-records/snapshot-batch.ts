import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import { readRecordDataBatch } from "../collection-schema/record-io";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";

export interface RecordSnapshot {
  label: string;
  collectionId: string;
  data: Record<string, unknown>;
}

/**
 * Batch-read display snapshots (label + type + field values) for records by id,
 * scoped to one team and potentially spanning collections. Powers the
 * field-type-aware before→after (update) / preview (delete) on a gated
 * `record_write` approval card. Read-only, one-time at pending creation — not a
 * hot path; ids not owned by `teamId` are silently absent from the result.
 */
export const getRecordSnapshots = async (input: {
  teamId: string;
  ids: string[];
}): Promise<Map<string, RecordSnapshot>> => {
  const out = new Map<string, RecordSnapshot>();
  if (input.ids.length === 0) return out;

  const heads = await db
    .select({
      id: collectionRecords.id,
      label: collectionRecords.label,
      collectionId: collectionRecords.collectionId,
    })
    .from(collectionRecords)
    .where(
      and(
        inArray(collectionRecords.id, input.ids),
        eq(collectionRecords.teamId, input.teamId),
      ),
    );

  // Group ids by type so each type's data is read in one batched pass.
  const idsByType = new Map<string, string[]>();
  for (const h of heads) {
    const list = idsByType.get(h.collectionId) ?? [];
    list.push(h.id);
    idsByType.set(h.collectionId, list);
  }

  for (const [collectionId, recordIds] of idsByType) {
    const fields = await getFieldDefinitionsForTeam({
      teamId: input.teamId,
      collectionId,
    });
    const dataById = await readRecordDataBatch({
      collectionId,
      recordIds,
      fields,
    });
    for (const h of heads) {
      if (h.collectionId !== collectionId) continue;
      out.set(h.id, {
        label: h.label,
        collectionId,
        data: dataById.get(h.id) ?? {},
      });
    }
  }
  return out;
};
