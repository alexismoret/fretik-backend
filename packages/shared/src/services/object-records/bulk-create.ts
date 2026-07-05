import { sql } from "drizzle-orm";
import db from "../../db";
import type { OntologySource, OntologyStatus } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import {
  chunkForBulk,
  DB_BULK_CHUNK_SIZE,
  formatBulkRowError,
} from "../../lib/db-bulk";
import { computeRecordIdentity } from "../../schemas/record-shape";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { bulkCreateLinks, type LinkInput } from "../links/bulk-create";
import {
  type RecordRelationInput,
  resolveRelationInputs,
} from "../links/resolve-relation-inputs";
import { resolveLocationRefsBatch } from "../locations/resolve-batch";
import { buildExtensionInsertBatch } from "../object-schema/record-io";
import { filterTeamMemberIds } from "../team/members";
import { buildCreateDiff } from "./create-diff";
import { validateRecordData } from "./validate";
import { collectMemberUserIds } from "./validate-members";

/** One row of a bulk create: the record's `data`, plus its outgoing relations. */
export interface BulkCreateRow {
  data: Record<string, unknown>;
  relations?: RecordRelationInput[];
}

/**
 * Positional result of a bulk create: `ids[i]` is the new record id for input
 * row `i`, or `null` when that row failed validation (its reason is in
 * `errors`). The alignment lets an in-sandbox migration map `rows[i] → ids[i]`
 * — e.g. to re-point links — without re-reading anything into agent context.
 * `relationErrors` reports relation failures, indexed by the ROW whose relation
 * could not be made (the record itself still succeeded).
 */
export interface BulkCreateResult {
  ids: (string | null)[];
  errors: { index: number; error: string }[];
  relationErrors: { index: number; error: string }[];
}

/**
 * Create MANY records of one object type in a batch, each with optional outgoing
 * relations. The bulk sibling of `createObjectRecord` (kept separate on purpose
 * — single-row writes throw on the first bad value and enlist in a caller's
 * `tx`; bulk skips bad rows and owns its transaction). Shares every business
 * rule with the single path: `validateRecordData`, member validation,
 * `computeRecordIdentity`, `buildExtensionInsert*`, the `record.created` journal
 * entry, and the same relation resolution + `bulkCreateLinks`.
 *
 * Performance contract — NO per-row SQL. Validation is in-memory; member
 * assignment is checked against ONE team-membership fetch for the whole batch;
 * the surviving rows are written in chunks of {@link DB_BULK_CHUNK_SIZE}, each a
 * single transaction of set-based statements. Relations are then resolved in two
 * grouped reads and written set-based. Unlike the single path the relation step
 * is NOT atomic with its record (partial-success contract): a failed relation is
 * reported in `relationErrors` without undoing the record.
 */
export const bulkCreateObjectRecords = async (input: {
  organizationId: string;
  teamId: string;
  userId?: string | null;
  objectTypeId: string;
  rows: BulkCreateRow[];
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
    ...new Set(
      input.rows.flatMap((r) => collectMemberUserIds(fieldDefs, r.data)),
    ),
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
        data: raw.data,
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

  // 1b. Resolve every location value to a FK into the per-team `locations` table
  //     — one batched, cached, best-effort pass before the transaction (geocode
  //     network is never held open inside the tx). Location isn't an identity
  //     field, so the labels computed above stand.
  const geocoded = await resolveLocationRefsBatch({
    teamId: input.teamId,
    fieldDefs,
    rows: prepared.map((p) => p.data),
  });
  geocoded.forEach((data, i) => {
    prepared[i]!.data = data;
  });

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

      // 4. `record.created` journal entries + provenance edges (role: subject)
      //    — the set-based emit sibling, dedup-keyed per record id.
      const { ids: eventIds } = await emitDomainEventsBulk({
        tx,
        organizationId: input.organizationId,
        teamId: input.teamId,
        actor,
        events: batch.map((p, i) => ({
          type: "record.created",
          subjectRecordId: inserted[i]?.id ?? null,
          payload: { diff: buildCreateDiff(p.data) },
          dedupKey: `record.created:${inserted[i]?.id ?? ""}`,
          recordLinks: [{ recordId: inserted[i]?.id ?? "", role: "subject" }],
        })),
      });

      // 5. Stamp each registry row's source_event_id in ONE UPDATE … FROM VALUES.
      const provenance = batch.map(
        (_, i) => sql`(${inserted[i]?.id}::uuid, ${eventIds[i]}::uuid)`,
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

  // 7. Relations of every successfully-created row — resolved in two grouped
  //    reads, written set-based. Partial success: failures are reported, never
  //    fatal to the record. Records are committed, so the edges see them.
  const relationErrors = await createRowRelations(input, ids);

  return { ids, errors, relationErrors };
};

/**
 * Resolve + write the relations of the rows that were created. Flattens every
 * surviving row's relations, resolves them in one batched pass, and links them
 * with `bulkCreateLinks`; maps each failure back to its row index.
 */
const createRowRelations = async (
  input: {
    organizationId: string;
    teamId: string;
    objectTypeId: string;
    rows: BulkCreateRow[];
    source?: OntologySource;
    actor?: EventActor;
  },
  ids: (string | null)[],
): Promise<{ index: number; error: string }[]> => {
  const relationErrors: { index: number; error: string }[] = [];

  const flat: { rowIndex: number; rel: RecordRelationInput }[] = [];
  input.rows.forEach((row, i) => {
    if (ids[i] == null) return;
    for (const rel of row.relations ?? []) flat.push({ rowIndex: i, rel });
  });
  if (flat.length === 0) return relationErrors;

  const { resolved, errors: resolveErrors } = await resolveRelationInputs({
    organizationId: input.organizationId,
    teamId: input.teamId,
    fromObjectTypeId: input.objectTypeId,
    relations: flat.map((f) => f.rel),
  });
  for (const e of resolveErrors) {
    relationErrors.push({
      index: flat[e.index]?.rowIndex ?? -1,
      error: e.error,
    });
  }

  const linkInputs: LinkInput[] = [];
  const linkRowIndex: number[] = [];
  resolved.forEach((target, i) => {
    if (!target) return;
    const rowIndex = flat[i]?.rowIndex ?? -1;
    const fromRecordId = ids[rowIndex];
    if (!fromRecordId) return;
    linkInputs.push({
      linkTypeId: target.linkTypeId,
      fromRecordId,
      toRecordId: target.toRecordId,
    });
    linkRowIndex.push(rowIndex);
  });

  if (linkInputs.length > 0) {
    const { errors: linkErrors } = await bulkCreateLinks({
      organizationId: input.organizationId,
      teamId: input.teamId,
      links: linkInputs,
      source: input.source,
      actor: input.actor,
    });
    for (const e of linkErrors) {
      relationErrors.push({
        index: linkRowIndex[e.index] ?? -1,
        error: e.error,
      });
    }
  }

  return relationErrors;
};
