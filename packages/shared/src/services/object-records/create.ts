import { eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type {
  ObjectRecordWithData,
  OntologySource,
  OntologyStatus,
} from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { computeRecordIdentity } from "../../schemas/record-shape";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { buildExtensionInsert } from "../object-schema/record-io";
import { validateRecordData } from "./validate";
import { assertMemberFieldsValid } from "./validate-members";

/**
 * Per-field create diff for the journal: every present attribute as a
 * `null → value` transition. `domain-events/history` folds these into the
 * record's attribute timeline.
 */
const buildCreateDiff = (
  data: Record<string, unknown>,
): Record<string, { from: null; to: unknown }> => {
  const diff: Record<string, { from: null; to: unknown }> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    diff[key] = { from: null, to: value };
  }
  return diff;
};

/**
 * Create an object record. Resolves the type's enabled field definitions,
 * validates `data` against them, computes the denormalized identity
 * (label / normalizedLabel / search_vector), inserts, and journals
 * `record.created` in the SAME transaction (the outbox guarantee).
 *
 * Defaults match the trust model: user writes are born `confirmed` /
 * `user_manual`. AI extraction passes `status: 'suggested'` and
 * `source: 'ai_extraction'`. `labelOverride` forces the label (the document
 * mirror passes the filename). `strict: false` keeps AI-extracted values as
 * lenient as pre-extraction. Pass `tx` to enlist in a caller's transaction
 * (e.g. the document-processing fold); omit it and the service opens its own.
 */
export const createObjectRecord = async (input: {
  organizationId: string;
  teamId: string;
  userId?: string | null;
  objectTypeId: string;
  data: Record<string, unknown>;
  status?: OntologyStatus;
  source?: OntologySource;
  confidence?: number | null;
  labelOverride?: string | null;
  documentId?: string | null;
  strict?: boolean;
  tx?: Transaction;
  actor?: EventActor;
}): Promise<ObjectRecordWithData> => {
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    objectTypeId: input.objectTypeId,
  });

  const data = validateRecordData({
    fieldDefs,
    data: input.data,
    strict: input.strict,
  });
  await assertMemberFieldsValid({ teamId: input.teamId, fieldDefs, data });
  const identity = computeRecordIdentity({
    fieldDefs,
    data,
    labelOverride: input.labelOverride,
  });
  const actor = input.actor ?? SYSTEM_ACTOR;

  const status = input.status ?? "confirmed";

  const run = async (tx: Transaction): Promise<ObjectRecordWithData> => {
    // 1. Registry row — system columns only (no `data`; typed values go to the
    //    per-type extension table below).
    const [row] = await tx
      .insert(objectRecords)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        userId: input.userId ?? null,
        objectTypeId: input.objectTypeId,
        label: identity.label,
        normalizedLabel: identity.normalizedLabel,
        searchVector: sql`to_tsvector('simple', ${identity.searchText})`,
        status,
        source: input.source ?? "user_manual",
        confidence: input.confidence == null ? null : String(input.confidence),
        documentId: input.documentId ?? null,
        // Actor stamps: on create, last-edited-by == created-by.
        createdByActor: actor.actorType,
        createdByUserId: actor.actorUserId ?? null,
        updatedByActor: actor.actorType,
        updatedByUserId: actor.actorUserId ?? null,
      })
      .returning();
    if (!row) {
      return throwHttpError(500, internalError());
    }

    // 2. Typed extension row (same id), with the validated scalar field values.
    await tx.execute(
      buildExtensionInsert({
        objectTypeId: input.objectTypeId,
        recordId: row.id,
        teamId: input.teamId,
        label: identity.label,
        status,
        fields: fieldDefs,
        data,
      }),
    );

    const event = await emitDomainEvent({
      tx,
      organizationId: input.organizationId,
      teamId: input.teamId,
      type: "record.created",
      actor,
      subjectRecordId: row.id,
      payload: { diff: buildCreateDiff(data) },
      recordLinks: [{ recordId: row.id, role: "subject" }],
    });

    const [withProvenance] = await tx
      .update(objectRecords)
      .set({ sourceEventId: event.id })
      .where(eq(objectRecords.id, row.id))
      .returning();
    return { ...(withProvenance ?? row), data };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
