import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import {
  objectRecords,
  toolApprovalRequests,
  type ToolApprovalRecordResult,
  type ToolApprovalRecordWriteItem,
  type ToolApprovalRequest,
} from "../../db/schema";
import type { EventActor } from "../domain-events/emit";
import { bulkCreateObjectRecords } from "../object-records/bulk-create";
import { bulkDeleteObjectRecords } from "../object-records/bulk-delete";
import { bulkUpdateObjectRecords } from "../object-records/bulk-update";
import { markConsumed } from "./complete";
import { isRecordWritePayload } from "./payload-guards";

/**
 * Execute a granted `record_write` approval — the user-selected subset of one
 * gated bulk object write (create / update / delete), through the same bulk
 * services the direct SDK path uses. Persists a per-item result positionally
 * aligned with the FULL item list (unselected entries are `{ skipped: true }`)
 * and returns it for tool-part substitution. Idempotent via the approval
 * status machine (claimed once).
 */
export const executeRecordWriteApproval = async (params: {
  approval: ToolApprovalRequest;
  selectedIndexes?: number[];
  edits?: { index: number; data: Record<string, unknown> }[];
}): Promise<ToolApprovalRecordResult[]> => {
  const payload = params.approval.payload;
  if (!isRecordWritePayload(payload)) {
    await markConsumed(params.approval.id, []);
    return [];
  }

  // Apply the reviewer's inline field edits (create = new values, update = the
  // patch), then persist the merged proposal so the card + a re-run reflect
  // exactly what was written.
  const editByIndex = new Map(
    (params.edits ?? []).map((e) => [e.index, e.data]),
  );
  const items: ToolApprovalRecordWriteItem[] =
    editByIndex.size > 0
      ? payload.items.map((item, i) =>
          editByIndex.has(i)
            ? { ...item, data: editByIndex.get(i) ?? item.data }
            : item,
        )
      : payload.items;
  if (editByIndex.size > 0) {
    await db
      .update(toolApprovalRequests)
      .set({ payload: { ...payload, items } })
      .where(eq(toolApprovalRequests.id, params.approval.id));
  }

  const selected = new Set(params.selectedIndexes ?? items.map((_, i) => i));
  // Selected items with their ORIGINAL index preserved (result alignment).
  const chosen: { index: number; item: ToolApprovalRecordWriteItem }[] = [];
  items.forEach((item, index) => {
    if (selected.has(index)) chosen.push({ index, item });
  });

  // Attribute like the direct objects SDK path (execActor in sandbox/objects.ts).
  const actor: EventActor = {
    actorType: "connector",
    actorUserId: params.approval.userId,
    conversationId: params.approval.conversationId,
  };

  const byIndex = new Map<number, ToolApprovalRecordResult>();

  if (payload.op === "create" && payload.objectTypeId !== undefined) {
    const objectTypeId = payload.objectTypeId;
    const rows = chosen.map((c) => ({
      data: c.item.data ?? {},
      relations: c.item.relations,
    }));
    const { ids, errors } = await bulkCreateObjectRecords({
      organizationId: params.approval.organizationId,
      teamId: params.approval.teamId,
      userId: params.approval.userId,
      objectTypeId,
      rows,
      actor,
    });
    const createdIds = ids.filter((id): id is string => id !== null);
    const labelRows =
      createdIds.length > 0
        ? await db
            .select({ id: objectRecords.id, label: objectRecords.label })
            .from(objectRecords)
            .where(inArray(objectRecords.id, createdIds))
        : [];
    const labelById = new Map(labelRows.map((r) => [r.id, r.label]));
    const errorByRow = new Map(errors.map((e) => [e.index, e.error]));
    chosen.forEach((c, rowIndex) => {
      const id = ids[rowIndex];
      byIndex.set(
        c.index,
        id !== null && id !== undefined
          ? { ok: true, id, label: labelById.get(id) ?? "" }
          : {
              ok: false,
              error: errorByRow.get(rowIndex) ?? "Record creation failed.",
            },
      );
    });
  } else if (payload.op === "update") {
    const updates = chosen
      .filter((c) => c.item.recordId !== undefined)
      .map((c) => ({ id: c.item.recordId ?? "", data: c.item.data ?? {} }));
    const { updatedIds, errors } = await bulkUpdateObjectRecords({
      teamId: params.approval.teamId,
      updates,
      merge: payload.merge,
      actor,
    });
    const updated = new Set(updatedIds);
    const errById = new Map(errors.map((e) => [e.id, e.error]));
    for (const c of chosen) {
      const recordId = c.item.recordId;
      if (recordId === undefined) {
        byIndex.set(c.index, { ok: false, error: "Missing record id." });
      } else if (updated.has(recordId)) {
        byIndex.set(c.index, {
          ok: true,
          id: recordId,
          label: c.item.currentLabel ?? "",
        });
      } else {
        byIndex.set(c.index, {
          ok: false,
          error: errById.get(recordId) ?? "Update failed.",
        });
      }
    }
  } else if (payload.op === "delete") {
    const ids = chosen
      .map((c) => c.item.recordId)
      .filter((id): id is string => id !== undefined);
    const { deletedIds, errors } = await bulkDeleteObjectRecords({
      teamId: params.approval.teamId,
      ids,
      actor,
    });
    const deleted = new Set(deletedIds);
    const errById = new Map(errors.map((e) => [e.id, e.error]));
    for (const c of chosen) {
      const recordId = c.item.recordId;
      if (recordId === undefined) {
        byIndex.set(c.index, { ok: false, error: "Missing record id." });
      } else if (deleted.has(recordId)) {
        byIndex.set(c.index, {
          ok: true,
          id: recordId,
          label: c.item.currentLabel ?? "",
        });
      } else {
        byIndex.set(c.index, {
          ok: false,
          error: errById.get(recordId) ?? "Delete failed.",
        });
      }
    }
  }

  const result: ToolApprovalRecordResult[] = items.map(
    (_, i) => byIndex.get(i) ?? { skipped: true },
  );
  await markConsumed(params.approval.id, result);
  return result;
};
