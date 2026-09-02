import { sql } from "drizzle-orm";
import db from "../../db";
import type { OntologySource, OntologyStatus } from "../../db/schema";
import { collectionRecords } from "../../db/schema";
import {
  chunkForBulk,
  chunkSizeForParams,
  formatBulkRowError,
} from "../../lib/db-bulk";
import { computeRecordIdentity } from "../../schemas/record-shape";
import { reconcileFieldIndexes } from "../collection-schema/reconcile-indexes";
import {
  buildExtensionInsertBatch,
  extensionColumnCount,
} from "../collection-schema/record-io";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { bulkCreateLinks, type LinkInput } from "../links/bulk-create";
import {
  type RecordRelationInput,
  resolveRelationInputs,
} from "../links/resolve-relation-inputs";
import { resolveLocationRefsBatch } from "../locations/resolve-batch";
import { filterTeamMemberIds } from "../team/members";
import { buildCreateDiff } from "./create-diff";
import { buildRecordDataValidator } from "./validate";
import { collectMemberUserIds } from "./validate-members";

/** Parameters the registry INSERT binds per row (see step 2 below). */
const REGISTRY_PARAMS_PER_ROW = 13;
/** System columns `buildExtensionInsertBatch` binds per row, before the fields. */
const EXTENSION_SYS_PARAMS = 4;

/**
 * Rows this service puts in ONE transaction for a type of this shape.
 *
 * Exported because a chunked import needs to size its OWN chunks to match:
 * when an import chunk equals a transaction, a chunk that throws is a chunk
 * that wrote nothing, and it can be retried safely. Split it any finer or any
 * coarser and "the call failed" stops implying "nothing landed" — which is the
 * whole basis of the import's exactly-once ledger.
 */
export const recordWriteChunkSize = (
  fieldDefs: Parameters<typeof extensionColumnCount>[0],
): number =>
  chunkSizeForParams(
    Math.max(
      REGISTRY_PARAMS_PER_ROW,
      EXTENSION_SYS_PARAMS + extensionColumnCount(fieldDefs),
    ),
  );

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
 * Create MANY records of one collection in a batch, each with optional outgoing
 * relations. The bulk sibling of `createCollectionRecord` (kept separate on purpose
 * — single-row writes throw on the first bad value and enlist in a caller's
 * `tx`; bulk skips bad rows and owns its transaction). Shares every business
 * rule with the single path: the same record validation, member validation,
 * `computeRecordIdentity`, `buildExtensionInsert*`, the `record.created` journal
 * entry, and the same relation resolution + `bulkCreateLinks`.
 *
 * Performance contract — NO per-row SQL, and no per-row CPU that the batch can
 * pay once. Validation is in-memory against ONE compiled validator; member
 * assignment is checked against ONE team-membership fetch for the whole batch;
 * the surviving rows are written in chunks sized by `chunkSizeForParams` from
 * this type's real column width, each a single transaction of set-based
 * statements. Relations are then resolved in two grouped reads and written
 * set-based. Unlike the single path the relation step is NOT atomic with its
 * record (partial-success contract): a failed relation is reported in
 * `relationErrors` without undoing the record.
 */
export const bulkCreateCollectionRecords = async (input: {
  organizationId: string;
  teamId: string;
  userId?: string | null;
  collectionId: string;
  rows: BulkCreateRow[];
  status?: OntologyStatus;
  source?: OntologySource;
  strict?: boolean;
  /**
   * Validate every row and return the per-row `errors` WITHOUT writing (no
   * geocode, no transaction, no relations). Used as the pre-approval dry-run
   * so a format error bounces to the agent before a human grants the write.
   * `ids`/`relationErrors` come back empty.
   */
  dryRun?: boolean;
  /**
   * Skip the trailing index reconcile. Set by a caller that writes ONE logical
   * load in several calls (a chunked import), which reconciles once after the
   * last one — that is the whole point of building indexes after the load, and
   * firing it per call would instead run N `CREATE INDEX CONCURRENTLY` passes
   * against the same table while the load is still going.
   */
  skipIndexReconcile?: boolean;
  actor?: EventActor;
}): Promise<BulkCreateResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const status = input.status ?? "confirmed";
  const source = input.source ?? "user_manual";

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    collectionId: input.collectionId,
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
  // Compiled ONCE for the whole batch: the Zod shape is a function of the
  // fields and `strict`, both loop-invariant. Building it per row cost one
  // discarded `z.object` (and one validator per field) for every row.
  const validator = buildRecordDataValidator({
    fieldDefs,
    strict: input.strict,
  });
  for (const [index, raw] of input.rows.entries()) {
    try {
      const data = validator.validate(raw.data);
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

  // Dry-run: validation done — report errors without touching the DB.
  if (input.dryRun) {
    return { ids: input.rows.map(() => null), errors, relationErrors: [] };
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

  // Size the chunk from what a row of THIS type actually binds: the widest of
  // the statements below is the extension insert (4 system columns + one per
  // scalar column), and the registry insert binds a fixed 13.
  const chunkSize = recordWriteChunkSize(fieldDefs);

  /**
   * Write ONE batch in ONE transaction. Extracted so the failure path below can
   * replay it row by row with the identical statements.
   */
  const writeBatch = async (batch: Prepared[]): Promise<void> => {
    await db.transaction(async (tx) => {
      // 2. Registry rows — system columns only. RETURNING preserves VALUES
      //    order, so `inserted[i]` pairs with `batch[i]`.
      const inserted = await tx
        .insert(collectionRecords)
        .values(
          batch.map((p) => ({
            organizationId: input.organizationId,
            teamId: input.teamId,
            userId: input.userId ?? null,
            collectionId: input.collectionId,
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
        .returning({ id: collectionRecords.id });

      // 3. Extension rows — one multi-row INSERT into data.coll_<collectionId>.
      const extension = buildExtensionInsertBatch({
        collectionId: input.collectionId,
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
        sql`UPDATE collection_records AS r
            SET source_event_id = v.event_id
            FROM (VALUES ${sql.join(provenance, sql`, `)}) AS v(record_id, event_id)
            WHERE r.id = v.record_id`,
      );

      batch.forEach((p, i) => {
        ids[p.index] = inserted[i]?.id ?? null;
      });
    });
  };

  for (const batch of chunkForBulk(prepared, chunkSize)) {
    try {
      await writeBatch(batch);
    } catch (error) {
      // The chunk's transaction rolled back — a constraint, a value Postgres
      // refused, a lost connection. Letting it throw would abandon the WHOLE
      // load (every other chunk included) over rows that are very likely fine,
      // and would break this service's per-row partial-success contract.
      //
      // Postgres names no row, so replay the chunk one row at a time with the
      // exact same statements: the rows that can land, land; the ones that
      // cannot get their own reason. The cost is bounded to the failing chunk,
      // and only ever paid when something already went wrong.
      //
      // Logged because the two outcomes mean different things: if the replay
      // then succeeds for every row, the fault was in the BATCH (a deadlock, a
      // statement too wide) and no per-row error will record it.
      console.warn(
        `[bulk-create] chunk of ${batch.length.toString()} failed on collection ${input.collectionId}, retrying row by row:`,
        error instanceof Error ? error.message : error,
      );
      for (const row of batch) {
        try {
          await writeBatch([row]);
        } catch (rowError) {
          ids[row.index] = null;
          errors.push({
            index: row.index,
            error: formatBulkRowError(rowError),
          });
        }
      }
    }
  }

  // 7. Relations of every successfully-created row — resolved in two grouped
  //    reads, written set-based. Partial success: failures are reported, never
  //    fatal to the record. Records are committed, so the edges see them.
  const relationErrors = await createRowRelations(input, ids);

  // 8. The moment to index: AFTER the load, never before it. Measured on 500k
  //    rows — loading with the indexes already in place takes 78 s, loading bare
  //    then building takes 13 s + 30 s for the same end state. This is also what
  //    makes "import a CSV, then build a page on it" fast: by the time the page
  //    is generated the table is already indexed.
  //
  //    Not awaited: `CREATE INDEX CONCURRENTLY` scales with the table and the
  //    rows are already committed and readable without it.
  if (input.skipIndexReconcile !== true) {
    void reconcileFieldIndexes({ collectionId: input.collectionId }).catch(
      (cause: unknown) => {
        console.warn(
          `[collection-records] index reconcile skipped for ${input.collectionId}:`,
          cause instanceof Error ? cause.message : cause,
        );
      },
    );
  }

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
    collectionId: string;
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
    fromCollectionId: input.collectionId,
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
