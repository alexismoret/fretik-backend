import { inArray, sql, type SQL } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import {
  chunkForBulk,
  chunkSizeForParams,
  formatBulkRowError,
} from "../../lib/db-bulk";
import { computeRecordIdentity } from "../../schemas/record-shape";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { resolveLocationRefsBatch } from "../locations/resolve-batch";
import {
  buildExtensionUpdateBatch,
  extensionColumnCount,
  readRecordDataBatch,
} from "../object-schema/record-io";
import { filterTeamMemberIds } from "../team/members";
import { buildRecordDataValidator } from "./validate";
import { collectMemberUserIds } from "./validate-members";

/** Parameters the registry UPDATE binds per row (id, label, normalized, search, event). */
const REGISTRY_UPDATE_PARAMS_PER_ROW = 5;
/** System columns `buildExtensionUpdateBatch` binds per row, before the fields. */
const EXTENSION_UPDATE_SYS_PARAMS = 2;

/**
 * The registry half of a bulk update, as one `UPDATE … FROM (VALUES …)`.
 *
 * Pure and exported so it can be asserted, because the thing that has to stay
 * true here is invisible at the call site: **`updated_at` is stamped
 * EXPLICITLY**. The column declares `$onUpdate` in the schema, which the
 * single-row `updateObjectRecord` gets for free — but that is a Drizzle
 * query-builder convenience, and a set-based statement never triggers it.
 * Omitting it froze the registry's `updated_at` at creation for every bulk
 * write, so `last_edited_time` and "sort by recently updated" both read the
 * creation date, sitting beside an updated-BY stamp that HAD been refreshed —
 * the worst shape a stale value can take, because half of it is right.
 * `now()` is the transaction clock: one write, one timestamp for the batch,
 * in step with `buildExtensionUpdateBatch`'s own.
 */
export const buildRegistryUpdateBatch = (input: {
  rows: {
    id: string;
    label: string;
    normalizedLabel: string;
    searchText: string;
    eventId: string;
  }[];
  actor: EventActor;
}): SQL => {
  const tuples = input.rows.map(
    (r) =>
      sql`(${r.id}::uuid, ${r.label}::text, ${r.normalizedLabel}::text, ${r.searchText}::text, ${r.eventId}::uuid)`,
  );
  return sql`UPDATE object_records AS r
      SET label = v.label,
          normalized_label = v.normalized_label,
          search_vector = to_tsvector('simple', v.search_text),
          source_event_id = v.event_id,
          updated_by_actor = ${input.actor.actorType}::domain_event_actor,
          updated_by_user_id = ${input.actor.actorUserId ?? null}::uuid,
          updated_at = now()
      FROM (VALUES ${sql.join(tuples, sql`, `)})
        AS v(id, label, normalized_label, search_text, event_id)
      WHERE r.id = v.id`;
};

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
  /**
   * Validate every update (with the same merge/member rules) and return the
   * per-id `errors` WITHOUT writing (no geocode, no transaction). Used as the
   * pre-approval dry-run. `updatedIds` comes back empty.
   */
  dryRun?: boolean;
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
    // One compiled validator per TYPE — the Zod shape depends on the type's
    // fields and `strict`, neither of which varies across the rows below.
    const validator = buildRecordDataValidator({
      fieldDefs: fds,
      strict: input.strict,
    });
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
        const parsed = validator.validate(effectiveData);
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
    // is the resolved FK. Skipped on dry-run (no write follows).
    if (!input.dryRun) {
      const geocoded = await resolveLocationRefsBatch({
        teamId: input.teamId,
        fieldDefs: fds,
        rows: prep.map((p) => p.data),
      });
      geocoded.forEach((data, i) => {
        prep[i]!.data = data;
      });
    }
    preparedByType.set(typeId, prep);
  }

  // Dry-run: validation done — report errors without touching the DB.
  if (input.dryRun) return { updatedIds: [], errors };

  // 5. Write per type, chunked.
  const updatedIds: string[] = [];
  for (const [typeId, prep] of preparedByType) {
    const fds = fieldDefsByType.get(typeId) ?? [];
    // Sized from THIS type's width: the extension update binds `id` + `label`
    // plus one parameter per scalar column, the registry update binds 5.
    const chunkSize = chunkSizeForParams(
      Math.max(
        REGISTRY_UPDATE_PARAMS_PER_ROW,
        EXTENSION_UPDATE_SYS_PARAMS + extensionColumnCount(fds),
      ),
    );
    for (const batch of chunkForBulk(prep, chunkSize)) {
      await db.transaction(async (tx) => {
        // `record.updated` has no natural once-only token — no dedupKey. One
        // team ⇒ one organization, so the batch's first row's org stands in.
        const { ids: eventIds } = await emitDomainEventsBulk({
          tx,
          organizationId: batch[0]!.organizationId,
          teamId: input.teamId,
          actor,
          events: batch.map((p) => ({
            type: "record.updated",
            subjectRecordId: p.id,
            payload: { diff: p.diff },
            recordLinks: [{ recordId: p.id, role: "subject" }],
          })),
        });

        await tx.execute(
          buildRegistryUpdateBatch({
            rows: batch.map((p, i) => ({
              id: p.id,
              label: p.label,
              normalizedLabel: p.normalizedLabel,
              searchText: p.searchText,
              eventId: eventIds[i] ?? "",
            })),
            actor,
          }),
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
