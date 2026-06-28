import { eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { ObjectRecordWithData, OntologySource } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { computeRecordIdentity } from "../../schemas/record-shape";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import {
  buildExtensionUpdate,
  readRecordData,
} from "../object-schema/record-io";
import { validateRecordData } from "./validate";
import { assertMemberFieldsValid } from "./validate-members";

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
 * Set an object record's `data`, re-validate against its type's field
 * definitions, recompute the denormalized identity + search_vector, and journal
 * `record.updated` carrying the field diff. Runs in one transaction so the row is
 * never left with `data` updated but `label` / `search_vector` / the journal
 * stale. The diff is the basis of attribute-history reconstruction
 * (`domain-events/history`).
 *
 * `merge` (default false): when true, `data` PATCHES the record — provided keys
 * overlay the current values, omitted keys are left untouched (pass an explicit
 * `null` to clear one). Reuses the `before` read already taken for the diff, so
 * it adds no query. Default (false) is a FULL REPLACE — every prior field not in
 * `data` is cleared (the bulk / migration contract). Interactive single edits
 * (`manageRecord`) use `merge: true` so "set the phone" never wipes the rest of
 * the record.
 */
export const setRecordData = async (input: {
  id: string;
  data: Record<string, unknown>;
  source?: OntologySource;
  strict?: boolean;
  merge?: boolean;
  /** Force the display label instead of deriving it from the title field. */
  labelOverride?: string | null;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<ObjectRecordWithData> => {
  const { id, data, source } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<ObjectRecordWithData> => {
    const existing = await tx.query.objectRecords.findFirst({
      columns: {
        id: true,
        organizationId: true,
        teamId: true,
        objectTypeId: true,
        label: true,
        normalizedLabel: true,
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

    // Prior typed values (from the extension table) — basis of the journal diff,
    // and the base layer when `merge` patches only the provided keys.
    const before = await readRecordData({
      objectTypeId: existing.objectTypeId,
      recordId: existing.id,
      fields: fieldDefs,
      tx,
    });

    const effectiveData = input.merge ? { ...before, ...data } : data;
    const parsed = validateRecordData({
      fieldDefs,
      data: effectiveData,
      strict: input.strict,
    });
    await assertMemberFieldsValid({
      teamId: existing.teamId,
      fieldDefs,
      data: parsed,
    });
    const identity = computeRecordIdentity({
      fieldDefs,
      data: parsed,
      labelOverride: input.labelOverride ?? null,
    });
    // Records whose name came from a `labelOverride` (e.g. the document mirror =
    // filename) or that have an empty title field keep their existing label —
    // never clear a name on a data update.
    const keepLabel = identity.label === "" && existing.label !== "";
    const label = keepLabel ? existing.label : identity.label;
    const normalizedLabel = keepLabel
      ? existing.normalizedLabel
      : identity.normalizedLabel;
    const searchText = keepLabel
      ? `${existing.label} ${identity.searchText}`
      : identity.searchText;

    const event = await emitDomainEvent({
      tx,
      organizationId: existing.organizationId,
      teamId: existing.teamId,
      type: "record.updated",
      actor,
      subjectRecordId: id,
      payload: { diff: buildUpdateDiff(before, parsed) },
      recordLinks: [{ recordId: id, role: "subject" }],
    });

    // Registry: system columns only.
    const [row] = await tx
      .update(objectRecords)
      .set({
        label,
        normalizedLabel,
        searchVector: sql`to_tsvector('simple', ${searchText})`,
        sourceEventId: event.id,
        // Refresh the last-edited-by stamp (created-by is left untouched).
        updatedByActor: actor.actorType,
        updatedByUserId: actor.actorUserId ?? null,
        ...(source ? { source } : {}),
      })
      .where(eq(objectRecords.id, id))
      .returning();
    if (!row) {
      return throwHttpError(404, notFound("Record not found"));
    }

    // Extension: full replace of the typed field columns + denormalized label.
    const ext = buildExtensionUpdate({
      objectTypeId: existing.objectTypeId,
      recordId: id,
      fields: fieldDefs,
      data: parsed,
      label,
      mode: "replace",
    });
    if (ext) await tx.execute(ext);

    return { ...row, data: parsed };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
