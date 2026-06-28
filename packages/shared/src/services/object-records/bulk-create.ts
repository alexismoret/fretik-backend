import { sql } from "drizzle-orm";
import db from "../../db";
import type { OntologySource, OntologyStatus } from "../../db/schema";
import { domainEventLinks, domainEvents, objectRecords } from "../../db/schema";
import {
  chunkForBulk,
  DB_BULK_CHUNK_SIZE,
  formatBulkRowError,
} from "../../lib/db-bulk";
import { computeRecordIdentity } from "../../schemas/record-shape";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { buildExtensionInsertBatch } from "../object-schema/record-io";
import { filterTeamMemberIds } from "../team/members";
import { validateRecordData } from "./validate";
import { collectMemberUserIds } from "./validate-members";

/**
 * Positional result of a bulk create: `ids[i]` is the new record id for input
 * row `i`, or `null` when that row failed validation (its reason is in
 * `errors`). The alignment lets an in-sandbox migration map `rows[i] → ids[i]`
 * — e.g. to re-point links — without re-reading anything into agent context.
 */
export interface BulkCreateResult {
  ids: (string | null)[];
  errors: { index: number; error: string }[];
}

/**
 * Create MANY records of one object type in a batch. The bulk sibling of
 * `createObjectRecord` (kept separate on purpose — single-row writes throw on
 * the first bad value and enlist in a caller's `tx`; bulk skips bad rows and
 * owns its transaction). Shares every business rule with the single path:
 * `validateRecordData`, member validation, `computeRecordIdentity`,
 * `buildExtensionInsert*`, the `record.created` journal entry.
 *
 * Performance contract — NO per-row SQL. Validation is in-memory; member
 * assignment is checked against ONE team-membership fetch for the whole batch;
 * the surviving rows are written in chunks of {@link INSERT_CHUNK}, each chunk a
 * single transaction of 5 set-based statements (registry INSERT, extension
 * INSERT, events INSERT, links INSERT, one `UPDATE … FROM (VALUES …)` to stamp
 * `source_event_id`). Total round-trips scale with chunk count, not row count.
 */
export const bulkCreateObjectRecords = async (input: {
  organizationId: string;
  teamId: string;
  userId?: string | null;
  objectTypeId: string;
  rows: Record<string, unknown>[];
  status?: OntologyStatus;
  source?: OntologySource;
  strict?: boolean;
  actor?: EventActor;
}): Promise<BulkCreateResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const status = input.status ?? "confirmed";
  const source = input.source ?? "user_manual";

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    objectTypeId: input.objectTypeId,
  });

  // One membership fetch for the whole batch (only when the type has member
  // fields) — never one per row. `filterTeamMemberIds` returns the subset of
  // requested ids that ARE team members; the complement is invalid.
  const requestedMembers = [
    ...new Set(input.rows.flatMap((r) => collectMemberUserIds(fieldDefs, r))),
  ];
  const allowedMembers = new Set(
    requestedMembers.length > 0
      ? await filterTeamMemberIds(input.teamId, requestedMembers)
      : [],
  );

  // 1. Validate every row in memory. Survivors keep their original index so the
  //    returned ids stay aligned with the caller's input array.
  type Prepared = {
    index: number;
    data: Record<string, unknown>;
    label: string;
    normalizedLabel: string;
    searchText: string;
  };
  const prepared: Prepared[] = [];
  const errors: { index: number; error: string }[] = [];
  for (const [index, raw] of input.rows.entries()) {
    try {
      const data = validateRecordData({
        fieldDefs,
        data: raw,
        strict: input.strict,
      });
      const invalidMembers = collectMemberUserIds(fieldDefs, data).filter(
        (id) => !allowedMembers.has(id),
      );
      if (invalidMembers.length > 0) {
        throw new Error(
          `Member field(s) reference non-team user(s): ${[...new Set(invalidMembers)].join(", ")}.`,
        );
      }
      const identity = computeRecordIdentity({ fieldDefs, data });
      prepared.push({ index, ...identity, data });
    } catch (error) {
      errors.push({ index, error: formatBulkRowError(error) });
    }
  }

  const ids: (string | null)[] = input.rows.map(() => null);

  for (const batch of chunkForBulk(prepared, DB_BULK_CHUNK_SIZE)) {
    await db.transaction(async (tx) => {
      // 2. Registry rows — system columns only. RETURNING preserves VALUES
      //    order, so `inserted[i]` pairs with `batch[i]`.
      const inserted = await tx
        .insert(objectRecords)
        .values(
          batch.map((p) => ({
            organizationId: input.organizationId,
            teamId: input.teamId,
            userId: input.userId ?? null,
            objectTypeId: input.objectTypeId,
            label: p.label,
            normalizedLabel: p.normalizedLabel,
            searchVector: sql`to_tsvector('simple', ${p.searchText})`,
            status,
            source,
            createdByActor: actor.actorType,
            createdByUserId: actor.actorUserId ?? null,
            updatedByActor: actor.actorType,
            updatedByUserId: actor.actorUserId ?? null,
          })),
        )
        .returning({ id: objectRecords.id });

      // 3. Extension rows — one multi-row INSERT into data.obj_<typeId>.
      const extension = buildExtensionInsertBatch({
        objectTypeId: input.objectTypeId,
        fields: fieldDefs,
        rows: batch.map((p, i) => ({
          recordId: inserted[i]?.id ?? "",
          teamId: input.teamId,
          label: p.label,
          status,
          data: p.data,
        })),
      });
      if (extension) await tx.execute(extension);

      // 4. `record.created` journal entries — one per record, with its diff.
      const events = await tx
        .insert(domainEvents)
        .values(
          batch.map((p, i) => ({
            organizationId: input.organizationId,
            teamId: input.teamId,
            type: "record.created",
            actorType: actor.actorType,
            actorUserId: actor.actorUserId ?? null,
            conversationId: actor.conversationId ?? null,
            subjectRecordId: inserted[i]?.id ?? null,
            payload: { diff: buildCreateDiff(p.data) },
          })),
        )
        .returning({ id: domainEvents.id });

      // 5. Event↔record provenance edges (role: subject).
      await tx.insert(domainEventLinks).values(
        batch.map((_, i) => ({
          eventId: events[i]?.id ?? "",
          recordId: inserted[i]?.id ?? "",
          role: "subject",
        })),
      );

      // 6. Stamp each registry row's source_event_id in ONE UPDATE … FROM VALUES.
      const provenance = batch.map(
        (_, i) => sql`(${inserted[i]?.id}::uuid, ${events[i]?.id}::uuid)`,
      );
      await tx.execute(
        sql`UPDATE object_records AS r
            SET source_event_id = v.event_id
            FROM (VALUES ${sql.join(provenance, sql`, `)}) AS v(record_id, event_id)
            WHERE r.id = v.record_id`,
      );

      batch.forEach((p, i) => {
        ids[p.index] = inserted[i]?.id ?? null;
      });
    });
  }

  return { ids, errors };
};

/**
 * Per-field create diff for the journal — mirrors `buildCreateDiff` in
 * `create.ts`: every present attribute as a `null → value` transition.
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
