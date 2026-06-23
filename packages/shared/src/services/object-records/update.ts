import { eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { ObjectRecord, OntologySource } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { computeRecordIdentity } from "../../schemas/record-shape";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { validateRecordData } from "./validate";

/**
 * Field-level diff between the prior and next `data` — only changed keys (added,
 * removed, value-changed), each `{ from, to }`. Removed keys carry `to: null`.
 * Compared structurally (JSON) so array / object values diff correctly.
 */
const buildUpdateDiff = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> => {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
};

/**
 * Replace an object record's `data` (full replace, not a merge), re-validate
 * against its type's field definitions, recompute the denormalized identity +
 * search_vector, and journal `record.updated` carrying the field diff. Runs in
 * one transaction so the row is never left with `data` updated but `label` /
 * `search_vector` / the journal stale. The diff is the basis of
 * attribute-history reconstruction (`domain-events/history`).
 */
export const setRecordData = async (input: {
  id: string;
  data: Record<string, unknown>;
  source?: OntologySource;
  strict?: boolean;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<ObjectRecord> => {
  const { id, data, source } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<ObjectRecord> => {
    const existing = await tx.query.objectRecords.findFirst({
      columns: {
        id: true,
        organizationId: true,
        teamId: true,
        objectTypeId: true,
        data: true,
      },
      where: { id },
    });
    if (!existing) {
      return throwHttpError(404, notFound("Record not found"));
    }

    const fieldDefs = await getFieldDefinitionsForTeam({
      teamId: existing.teamId,
      objectTypeId: existing.objectTypeId,
    });

    const parsed = validateRecordData({
      fieldDefs,
      data,
      strict: input.strict,
    });
    const identity = computeRecordIdentity({ fieldDefs, data: parsed });

    const event = await emitDomainEvent({
      tx,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      type: "record.updated",
      actor,
      subjectRecordId: id,
      payload: { diff: buildUpdateDiff(existing.data, parsed) },
      recordLinks: [{ recordId: id, role: "subject" }],
    });

    const [row] = await tx
      .update(objectRecords)
      .set({
        data: parsed,
        label: identity.label,
        normalizedLabel: identity.normalizedLabel,
        searchVector: sql`to_tsvector('simple', ${identity.searchText})`,
        sourceEventId: event.id,
        ...(source ? { source } : {}),
      })
      .where(eq(objectRecords.id, id))
      .returning();
    if (!row) {
      return throwHttpError(404, notFound("Record not found"));
    }
    return row;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
