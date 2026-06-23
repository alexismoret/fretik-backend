import { eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type {
  ObjectRecord,
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
import { validateRecordData } from "./validate";

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
}): Promise<ObjectRecord> => {
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    objectTypeId: input.objectTypeId,
  });

  const data = validateRecordData({
    fieldDefs,
    data: input.data,
    strict: input.strict,
  });
  const identity = computeRecordIdentity({
    fieldDefs,
    data,
    labelOverride: input.labelOverride,
  });
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: Transaction): Promise<ObjectRecord> => {
    const [row] = await tx
      .insert(objectRecords)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        userId: input.userId ?? null,
        objectTypeId: input.objectTypeId,
        data,
        label: identity.label,
        normalizedLabel: identity.normalizedLabel,
        searchVector: sql`to_tsvector('simple', ${identity.searchText})`,
        status: input.status ?? "confirmed",
        source: input.source ?? "user_manual",
        confidence: input.confidence == null ? null : String(input.confidence),
        documentId: input.documentId ?? null,
      })
      .returning();
    if (!row) {
      return throwHttpError(500, internalError());
    }

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
    return withProvenance ?? row;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};
