import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { readRecordDataBatch } from "../object-schema/record-io";

export interface RecordSnapshot {
  label: string;
  objectTypeId: string;
  data: Record<string, unknown>;
}

/**
 * Batch-read display snapshots (label + type + field values) for records by id,
 * scoped to one team and potentially spanning object types. Powers the
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
      id: objectRecords.id,
      label: objectRecords.label,
      objectTypeId: objectRecords.objectTypeId,
    })
    .from(objectRecords)
    .where(
      and(
        inArray(objectRecords.id, input.ids),
        eq(objectRecords.teamId, input.teamId),
      ),
    );

  // Group ids by type so each type's data is read in one batched pass.
  const idsByType = new Map<string, string[]>();
  for (const h of heads) {
    const list = idsByType.get(h.objectTypeId) ?? [];
    list.push(h.id);
    idsByType.set(h.objectTypeId, list);
  }

  for (const [objectTypeId, recordIds] of idsByType) {
    const fields = await getFieldDefinitionsForTeam({
      teamId: input.teamId,
      objectTypeId,
    });
    const dataById = await readRecordDataBatch({
      objectTypeId,
      recordIds,
      fields,
    });
    for (const h of heads) {
      if (h.objectTypeId !== objectTypeId) continue;
      out.set(h.id, {
        label: h.label,
        objectTypeId,
        data: dataById.get(h.id) ?? {},
      });
    }
  }
  return out;
};
