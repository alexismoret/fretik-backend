import { and, inArray, isNull, sql } from "drizzle-orm";
import db, { type Executor, type Transaction } from "../../db";
import type { OntologySource, OntologyStatus } from "../../db/schema";
import { collectionRecords, links, linkTypes } from "../../db/schema";
import { chunkForBulk, DB_BULK_CHUNK_SIZE } from "../../lib/db-bulk";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";

/** One edge to create, addressed by ids (resolution happens before this). */
export interface LinkInput {
  linkTypeId: string;
  fromRecordId: string;
  toRecordId: string;
  props?: Record<string, unknown>;
  confidence?: number | null;
  /** Trust band; omit → `confirmed` (the column default). */
  status?: OntologyStatus;
}

export interface BulkCreateLinksResult {
  /** Aligned to input: the new edge id, or null when skipped (a validation
   *  error — see `errors`) or a no-op (the active edge already existed). */
  ids: (string | null)[];
  errors: { index: number; error: string }[];
}

interface ValidLink {
  index: number;
  linkTypeId: string;
  fromRecordId: string;
  toRecordId: string;
  props: Record<string, unknown>;
  confidence: string | null;
  status: OntologyStatus | undefined;
  recordedAt: Date | null;
}

const edgeKey = (
  linkTypeId: string,
  fromRecordId: string,
  toRecordId: string,
): string => `${linkTypeId}|${fromRecordId}|${toRecordId}`;

/**
 * Set-based sibling of `createLink` — validate and insert MANY edges with NO
 * per-row SQL. Validation is two grouped reads (every referenced link type,
 * every referenced record) then in-memory type checks (same rules as
 * `createLink`); survivors are written in chunks, each chunk a handful of
 * set-based statements: the `links` INSERT with the active-edge
 * `onConflictDoNothing`, the `link.created` journal rows, their event↔record
 * provenance, and one `UPDATE … FROM (VALUES …)` to stamp `source_event_id`.
 * Idempotent — an already-active edge is a no-op (null id, no error). Pass `tx`
 * to enlist in a caller's transaction so the reads see records created earlier
 * in it (the create-with-relations path); omit it and each chunk is its own
 * transaction (the bulk path).
 */
export const bulkCreateLinks = async (input: {
  organizationId: string;
  teamId: string;
  links: LinkInput[];
  source?: OntologySource;
  actor?: EventActor;
  tx?: Transaction;
}): Promise<BulkCreateLinksResult> => {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const source = input.source ?? "user_manual";
  const reader: Executor = input.tx ?? db;

  const ids: (string | null)[] = input.links.map(() => null);
  const errors: { index: number; error: string }[] = [];
  if (input.links.length === 0) return { ids, errors };

  // Two grouped reads — every referenced link type + every referenced record.
  const linkTypeIds = [...new Set(input.links.map((l) => l.linkTypeId))];
  const recordIds = [
    ...new Set(input.links.flatMap((l) => [l.fromRecordId, l.toRecordId])),
  ];
  const linkTypeRows = await reader
    .select({
      id: linkTypes.id,
      fromCollectionId: linkTypes.fromCollectionId,
      toCollectionId: linkTypes.toCollectionId,
      isTemporal: linkTypes.isTemporal,
    })
    .from(linkTypes)
    .where(inArray(linkTypes.id, linkTypeIds));
  const recordRows = await reader
    .select({
      id: collectionRecords.id,
      collectionId: collectionRecords.collectionId,
    })
    .from(collectionRecords)
    .where(inArray(collectionRecords.id, recordIds));
  const linkTypeById = new Map(linkTypeRows.map((r) => [r.id, r]));
  const typeByRecord = new Map(recordRows.map((r) => [r.id, r.collectionId]));

  // In-memory validation — same rules as createLink, no per-row SQL.
  const valid: ValidLink[] = [];
  for (const [index, l] of input.links.entries()) {
    const lt = linkTypeById.get(l.linkTypeId);
    if (!lt) {
      errors.push({ index, error: "Link type not found." });
      continue;
    }
    const fromType = typeByRecord.get(l.fromRecordId);
    const toType = typeByRecord.get(l.toRecordId);
    if (fromType === undefined || toType === undefined) {
      errors.push({ index, error: "Record not found." });
      continue;
    }
    if (fromType !== lt.fromCollectionId) {
      errors.push({
        index,
        error: "Source record type does not match the relation.",
      });
      continue;
    }
    if (lt.toCollectionId !== null && toType !== lt.toCollectionId) {
      errors.push({
        index,
        error: "Target record type does not match the relation.",
      });
      continue;
    }
    valid.push({
      index,
      linkTypeId: l.linkTypeId,
      fromRecordId: l.fromRecordId,
      toRecordId: l.toRecordId,
      props: l.props ?? {},
      confidence: l.confidence == null ? null : String(l.confidence),
      status: l.status,
      recordedAt: lt.isTemporal ? new Date() : null,
    });
  }
  if (valid.length === 0) return { ids, errors };

  // First input position per active edge (a duplicate in the same input maps to
  // the single row the unique index keeps).
  const indexByEdge = new Map<string, number>();
  for (const v of valid) {
    const k = edgeKey(v.linkTypeId, v.fromRecordId, v.toRecordId);
    if (!indexByEdge.has(k)) indexByEdge.set(k, v.index);
  }

  const writeChunk = async (
    exec: Transaction,
    chunk: ValidLink[],
  ): Promise<void> => {
    const inserted = await exec
      .insert(links)
      .values(
        chunk.map((v) => ({
          organizationId: input.organizationId,
          teamId: input.teamId,
          linkTypeId: v.linkTypeId,
          fromRecordId: v.fromRecordId,
          toRecordId: v.toRecordId,
          props: v.props,
          source,
          ...(v.status ? { status: v.status } : {}),
          confidence: v.confidence,
          recordedAt: v.recordedAt,
        })),
      )
      .onConflictDoNothing({
        target: [links.linkTypeId, links.fromRecordId, links.toRecordId],
        where: and(isNull(links.validTo), isNull(links.invalidatedAt)),
      })
      .returning({
        id: links.id,
        linkTypeId: links.linkTypeId,
        fromRecordId: links.fromRecordId,
        toRecordId: links.toRecordId,
      });
    if (inserted.length === 0) return;

    // `link.created` journal rows + provenance edges — the set-based emit
    // sibling, dedup-keyed per edge id (an edge is created once).
    const { ids: eventIds } = await emitDomainEventsBulk({
      tx: exec,
      organizationId: input.organizationId,
      teamId: input.teamId,
      actor,
      events: inserted.map((l) => ({
        type: "link.created",
        payload: {
          linkId: l.id,
          linkTypeId: l.linkTypeId,
          fromRecordId: l.fromRecordId,
          toRecordId: l.toRecordId,
        },
        dedupKey: `link.created:${l.id}`,
        recordLinks: [
          { recordId: l.fromRecordId, role: "affected" },
          { recordId: l.toRecordId, role: "affected" },
        ],
      })),
    });

    const provenance = inserted.map(
      (l, i) => sql`(${l.id}::uuid, ${eventIds[i]}::uuid)`,
    );
    await exec.execute(
      sql`UPDATE links AS l
          SET source_event_id = v.event_id
          FROM (VALUES ${sql.join(provenance, sql`, `)}) AS v(link_id, event_id)
          WHERE l.id = v.link_id`,
    );

    for (const l of inserted) {
      const idx = indexByEdge.get(
        edgeKey(l.linkTypeId, l.fromRecordId, l.toRecordId),
      );
      if (idx !== undefined) ids[idx] = l.id;
    }
  };

  for (const chunk of chunkForBulk(valid, DB_BULK_CHUNK_SIZE)) {
    if (input.tx) await writeChunk(input.tx, chunk);
    else await db.transaction((t) => writeChunk(t, chunk));
  }

  return { ids, errors };
};
