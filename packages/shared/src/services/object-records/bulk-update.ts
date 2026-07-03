import { inArray, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { domainEventLinks, domainEvents, objectRecords } from "../../db/schema";
import { chunkForBulk, formatBulkRowError } from "../../lib/db-bulk";
import { computeRecordIdentity } from "../../schemas/record-shape";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { resolveLocationRefsBatch } from "../locations/resolve-batch";
import {
  buildExtensionUpdateBatch,
  readRecordDataBatch,
} from "../object-schema/record-io";
import { filterTeamMemberIds } from "../team/members";
import { validateRecordData } from "./validate";
import { collectMemberUserIds } from "./validate-members";

/** Result of a bulk update: the records actually rewritten + per-id failures. */
export interface BulkUpdateResult {
  updatedIds: string[];
  errors: { id: string; error: string }[];
}

interface RegistryRow {
  id: string;
  organizationId: string;
  teamId: string;
  objectTypeId: string;
  label: string;
  normalizedLabel: string;
}

interface PreparedUpdate {
  id: string;
  organizationId: string;
  data: Record<string, unknown>;
  label: string;
  normalizedLabel: string;
  searchText: string;
  diff: Record<string, { from: unknown; to: unknown }>;
}

/**
 * Full-replace the `data` of MANY owned records in a batch. The bulk sibling of
 * `setRecordData`: same validation, same identity/search recompute, same
 * `record.updated` journal entry with a field diff — but set-based. Records are
 * grouped by type; per type, each chunk runs ONE transaction of batched
 * statements (events INSERT, links INSERT, registry `UPDATE … FROM (VALUES …)`,
 * extension `UPDATE … FROM (VALUES …)`). No per-row SQL.
 *
 * `merge` (default false) mirrors `setRecordData`: when true, each record's
 * `data` PATCHES the stored row (only the provided keys change; send `null` to
 * clear one) — the partial-update path. When false, `data` is a COMPLETE field
 * map and omitted keys are cleared (the migration / full-replace path). Tenancy
 * is enforced here: ids not owned by `teamId` (other teams, made-up ids) come
 * back in `errors`. Duplicate ids collapse to the last value.
 */
export const bulkUpdateObjectRecords = async (input: {
  teamId: string;
  updates: { id: string; data: Record<string, unknown> }[];
  merge?: boolean;
  strict?: boolean;
  actor?: EventActor;
}): Promise<BulkUpdateResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;

  // Last write per id wins.
  const dataById = new Map<string, Record<string, unknown>>();
  for (const u of input.updates) dataById.set(u.id, u.data);
  const requestedIds = [...dataById.keys()];
  if (requestedIds.length === 0) return { updatedIds: [], errors: [] };

  // 1. Owned registry rows (chunked SELECT).
  const recById = new Map<string, RegistryRow>();
  for (const idChunk of chunkForBulk(requestedIds)) {
    const rows = await db
      .select({
        id: objectRecords.id,
        organizationId: objectRecords.organizationId,
        teamId: objectRecords.teamId,
        objectTypeId: objectRecords.objectTypeId,
        label: objectRecords.label,
        normalizedLabel: objectRecords.normalizedLabel,
      })
      .from(objectRecords)
      .where(inArray(objectRecords.id, idChunk));
    for (const r of rows) if (r.teamId === input.teamId) recById.set(r.id, r);
  }

  const errors: { id: string; error: string }[] = requestedIds
    .filter((id) => !recById.has(id))
    .map((id) => ({ id, error: "Record not found in your team." }));

  // 2. Group owned ids by type, and load each type's field defs + prior data.
  const byType = new Map<string, string[]>();
  for (const id of requestedIds) {
    const rec = recById.get(id);
    if (!rec) continue;
    const arr = byType.get(rec.objectTypeId) ?? [];
    arr.push(id);
    byType.set(rec.objectTypeId, arr);
  }
  const fieldDefsByType = new Map<string, FieldDefinition[]>();
  const beforeByType = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [typeId, ids] of byType) {
    const fds = await getFieldDefinitionsForTeam({
      teamId: input.teamId,
      objectTypeId: typeId,
    });
    fieldDefsByType.set(typeId, fds);
    beforeByType.set(
      typeId,
      await readRecordDataBatch({
        objectTypeId: typeId,
        recordIds: ids,
        fields: fds,
      }),
    );
  }

  // 3. One team-membership fetch for the whole batch.
  const requestedMembers = new Set<string>();
  for (const [typeId, ids] of byType) {
    const fds = fieldDefsByType.get(typeId) ?? [];
    for (const id of ids) {
      for (const m of collectMemberUserIds(fds, dataById.get(id) ?? {})) {
        requestedMembers.add(m);
      }
    }
  }
  const allowedMembers = new Set(
    requestedMembers.size > 0
      ? await filterTeamMemberIds(input.teamId, [...requestedMembers])
      : [],
  );

  // 4. Validate + prepare each row in memory (no SQL).
  const preparedByType = new Map<string, PreparedUpdate[]>();
  for (const [typeId, ids] of byType) {
    const fds = fieldDefsByType.get(typeId) ?? [];
    const before =
      beforeByType.get(typeId) ?? new Map<string, Record<string, unknown>>();
    const prep: PreparedUpdate[] = [];
    for (const id of ids) {
      const rec = recById.get(id);
      if (!rec) continue;
      try {
        // merge: patch the provided keys over the stored row; otherwise the
        // provided map replaces the row wholesale (omitted keys clear).
        const provided = dataById.get(id) ?? {};
        const effectiveData = input.merge
          ? { ...(before.get(id) ?? {}), ...provided }
          : provided;
        const parsed = validateRecordData({
          fieldDefs: fds,
          data: effectiveData,
          strict: input.strict,
        });
        const invalidMembers = collectMemberUserIds(fds, parsed).filter(
          (m) => !allowedMembers.has(m),
        );
        if (invalidMembers.length > 0) {
          throw new Error(
            `Member field(s) reference non-team user(s): ${[...new Set(invalidMembers)].join(", ")}.`,
          );
        }
        const identity = computeRecordIdentity({
          fieldDefs: fds,
          data: parsed,
        });
        // Records whose title field is now empty keep their existing label —
        // never clear a name on a data update (mirrors `setRecordData`).
        const keepLabel = identity.label === "" && rec.label !== "";
        prep.push({
          id,
          organizationId: rec.organizationId,
          data: parsed,
          label: keepLabel ? rec.label : identity.label,
          normalizedLabel: keepLabel
            ? rec.normalizedLabel
            : identity.normalizedLabel,
          searchText: keepLabel
            ? `${rec.label} ${identity.searchText}`
            : identity.searchText,
          diff: buildUpdateDiff(before.get(id) ?? {}, parsed),
        });
      } catch (error) {
        errors.push({ id, error: formatBulkRowError(error) });
      }
    }
    // Resolve every location value to a FK into the per-team `locations` table —
    // one batched, cached, best-effort pass per type before the transaction. The
    // diff above reflects the caller's edit (the LocationValue); the stored value
    // is the resolved FK.
    const geocoded = await resolveLocationRefsBatch({
      teamId: input.teamId,
      fieldDefs: fds,
      rows: prep.map((p) => p.data),
    });
    geocoded.forEach((data, i) => {
      prep[i]!.data = data;
    });
    preparedByType.set(typeId, prep);
  }

  // 5. Write per type, chunked.
  const updatedIds: string[] = [];
  for (const [typeId, prep] of preparedByType) {
    const fds = fieldDefsByType.get(typeId) ?? [];
    for (const batch of chunkForBulk(prep)) {
      await db.transaction(async (tx) => {
        const events = await tx
          .insert(domainEvents)
          .values(
            batch.map((p) => ({
              organizationId: p.organizationId,
              teamId: input.teamId,
              type: "record.updated",
              actorType: actor.actorType,
              actorUserId: actor.actorUserId ?? null,
              conversationId: actor.conversationId ?? null,
              subjectRecordId: p.id,
              payload: { diff: p.diff },
            })),
          )
          .returning({ id: domainEvents.id });

        await tx.insert(domainEventLinks).values(
          batch.map((p, i) => ({
            eventId: events[i]?.id ?? "",
            recordId: p.id,
            role: "subject",
          })),
        );

        // Registry: label / normalized_label / search_vector / source_event_id
        // per row; updated-by stamp is constant across the batch.
        const regTuples = batch.map(
          (p, i) =>
            sql`(${p.id}::uuid, ${p.label}::text, ${p.normalizedLabel}::text, ${p.searchText}::text, ${events[i]?.id}::uuid)`,
        );
        await tx.execute(
          sql`UPDATE object_records AS r
              SET label = v.label,
                  normalized_label = v.normalized_label,
                  search_vector = to_tsvector('simple', v.search_text),
                  source_event_id = v.event_id,
                  updated_by_actor = ${actor.actorType}::domain_event_actor,
                  updated_by_user_id = ${actor.actorUserId ?? null}::uuid
              FROM (VALUES ${sql.join(regTuples, sql`, `)})
                AS v(id, label, normalized_label, search_text, event_id)
              WHERE r.id = v.id`,
        );

        const ext = buildExtensionUpdateBatch({
          objectTypeId: typeId,
          fields: fds,
          rows: batch.map((p) => ({
            recordId: p.id,
            label: p.label,
            data: p.data,
          })),
        });
        if (ext) await tx.execute(ext);

        for (const p of batch) updatedIds.push(p.id);
      });
    }
  }

  return { updatedIds, errors };
};

/**
 * Field-level diff between prior and next `data` — mirrors `buildUpdateDiff` in
 * `update.ts`: only changed keys, each `{ from, to }`, removed keys carry
 * `to: null`. Compared structurally so array / object values diff correctly.
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
