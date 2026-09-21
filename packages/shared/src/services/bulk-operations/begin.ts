import { and, eq, gt, isNull, sql } from "drizzle-orm";
import db from "../../db";
import type {
  BulkOperation,
  BulkOperationChunk,
  BulkOperationKind,
  BulkOperationMode,
  BulkOperationParams,
} from "../../db/schema";
import { bulkOperationChunks, bulkOperations } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { CARD_INDEX_ROW_CEILING } from "../collection-records/card-indexing-policy";

/**
 * Rows one operation may carry.
 *
 * Not a transport limit — the chunking removed that — but a sanity bound on a
 * single logical load: past a million rows the honest tool is a database
 * restore, not an assistant, and an unbounded ceiling only means an accidental
 * runaway takes hours to become visible.
 */
export const MAX_BULK_OPERATION_ITEMS = 1_000_000;

/** Sample rows kept on the operation — the card's evidence, not a preview. */
export const BULK_OPERATION_SAMPLE_SIZE = 3;

/** What `beginBulkOperation` resolved the caller's submission to. */
export interface BulkOperationHandle {
  operation: BulkOperation;
  /**
   * Chunk indexes already accounted for — uploaded (staged mode) or applied
   * (direct mode). A resumed caller skips exactly these, which is what makes a
   * re-run after a crash cost nothing instead of re-sending 200 000 rows.
   */
  doneChunks: number[];
  /** True when this call created the row rather than matching an existing one. */
  created: boolean;
}

/**
 * Find or create the operation for a submission.
 *
 * Idempotent on `(conversationId, lookupHash)` — the unique index IS the
 * concurrency control, so two racing submissions of the same load converge on
 * one row instead of opening two. A caller that re-runs its code after an
 * approval, a crash or a sandbox recycle lands here and gets the SAME
 * operation back, along with what it already sent.
 *
 * A terminal row is returned as-is: deciding what a `done` or `failed`
 * operation means for the caller is the caller's job (replay the counters, or
 * surface the failure), not this function's.
 */
export const beginBulkOperation = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
  /** Omitted by an API load — see the column's note on the table. */
  conversationId?: string;
  turnId?: string;
  kind: BulkOperationKind;
  mode: BulkOperationMode;
  lookupHash: string;
  totalItems: number;
  chunkSize: number;
  params: BulkOperationParams;
  sample: Record<string, unknown>[];
  columns?: string[];
}): Promise<BulkOperationHandle> => {
  if (input.totalItems < 1 || input.totalItems > MAX_BULK_OPERATION_ITEMS) {
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `A bulk operation carries between 1 and ${MAX_BULK_OPERATION_ITEMS.toString()} rows (got ${input.totalItems.toString()}). Split the load.`,
    });
  }

  const conversationId = input.conversationId ?? null;

  const [inserted] = await db
    .insert(bulkOperations)
    .values({
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.userId,
      conversationId,
      turnId: input.turnId ?? null,
      kind: input.kind,
      mode: input.mode,
      lookupHash: input.lookupHash,
      totalItems: input.totalItems,
      chunkSize: input.chunkSize,
      params: input.params,
      sample: input.sample.slice(0, BULK_OPERATION_SAMPLE_SIZE),
      ...(input.columns ? { columns: input.columns } : {}),
    })
    // Two indexes enforce the same rule on two populations, because a NULL
    // `conversation_id` is distinct from every other one and would dedupe
    // nothing. The target must name the one that actually covers this row.
    .onConflictDoNothing(
      conversationId === null
        ? {
            target: [bulkOperations.teamId, bulkOperations.lookupHash],
            // The partial index's own predicate — `where` here is part of the
            // conflict TARGET, not a filter on the insert.
            where: isNull(bulkOperations.conversationId),
          }
        : {
            target: [bulkOperations.conversationId, bulkOperations.lookupHash],
          },
    )
    .returning();

  if (inserted !== undefined) {
    await relaxSemanticIndexForLoad(inserted);
    return { operation: inserted, doneChunks: [], created: true };
  }

  const existing = await db.query.bulkOperations.findFirst({
    where:
      conversationId === null
        ? {
            teamId: input.teamId,
            conversationId: { isNull: true },
            lookupHash: input.lookupHash,
          }
        : { conversationId, lookupHash: input.lookupHash },
  });
  if (existing === undefined) {
    // The conflict fired, so the row exists — unless it was deleted between
    // the two statements (conversation cascade). Nothing sane to resume.
    return throwHttpError(409, {
      code: ERROR_CODES.ALREADY_EXIST,
      message: "Bulk operation vanished between claim and read — retry.",
    });
  }
  return {
    operation: existing,
    doneChunks: await listDoneChunkIndexes(existing.id),
    created: false,
  };
};

/**
 * Take a collection out of the per-record embedding when a load announces more
 * rows than it is worth embedding.
 *
 * The decision already exists — `cardIndexVerdict` takes a collection above
 * `CARD_INDEX_ROW_CEILING` out on its own — but it reads `reltuples`, which
 * INSERTs do not maintain. A collection receiving 200 000 rows still measures
 * as the empty one it was until autoanalyze catches up, so the first ~20 000
 * records of the import are embedded before the verdict flips: 20 000
 * embedding calls and 20 000 vector rows, bought for a collection that was
 * always going to be excluded.
 *
 * The caller ANNOUNCED its size, which is the number `reltuples` will not know
 * for another few minutes, so the rule is applied at the load's birth from
 * that. `semantic_index IS NULL` only — an explicit `true` is somebody's
 * choice and stands, exactly as it does for a sync source.
 */
const relaxSemanticIndexForLoad = async (
  operation: BulkOperation,
): Promise<void> => {
  // Only a load that ADDS rows changes the count the verdict turns on.
  if (operation.kind !== "record_import") return;
  if (operation.totalItems < CARD_INDEX_ROW_CEILING) return;
  await db.execute(sql`
    UPDATE collections SET semantic_index = false
     WHERE id = ${operation.params.collectionId}::uuid
       AND semantic_index IS NULL`);
};

/**
 * Chunk indexes the caller no longer needs to send.
 *
 * In `staged` mode a row exists as soon as the chunk was uploaded; in `direct`
 * mode the row is written before the apply, so an index appearing here may be a
 * chunk that crashed mid-apply. Returning it anyway is the SAFE direction: the
 * runner reports that chunk instead of replaying it, where re-sending would
 * risk writing its rows twice.
 */
export const listDoneChunkIndexes = async (
  operationId: string,
): Promise<number[]> => {
  const rows = await db
    .select({ chunkIndex: bulkOperationChunks.chunkIndex })
    .from(bulkOperationChunks)
    .where(eq(bulkOperationChunks.operationId, operationId))
    .orderBy(bulkOperationChunks.chunkIndex);
  return rows.map((r) => r.chunkIndex);
};

/**
 * Are all the chunks in? Compares the ledger's row total against what the
 * caller announced, so a load that lost a chunk to a dropped request is caught
 * before anyone is asked to approve it — the alternative being an import that
 * silently writes 198 000 of 200 000 rows.
 */
export const countStagedItems = async (
  operationId: string,
): Promise<number> => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(item_count), 0)::int` })
    .from(bulkOperationChunks)
    .where(eq(bulkOperationChunks.operationId, operationId));
  return row?.total ?? 0;
};

/**
 * The next chunk still to apply — the runner's cursor, ONE row at a time.
 *
 * Deliberately not "every pending chunk": a chunk carries its rows in `items`,
 * so a million-row load parked as 500 chunks of 2 000 would arrive as one
 * result set holding the entire import — the exact thing the chunking exists to
 * avoid. The drain needs one chunk to work on, and the ledger is already the
 * cursor.
 *
 * `afterIndex` is what keeps the loop finite. Every applied chunk is stamped
 * (success, or the interruption report), so re-asking without a cursor would
 * still terminate — but a chunk whose stamp is lost to a crash mid-UPDATE would
 * be handed back for ever, and the caller has just walked past it.
 */
export const nextPendingChunk = async (
  operationId: string,
  afterIndex: number,
): Promise<BulkOperationChunk | undefined> => {
  const [row] = await db
    .select()
    .from(bulkOperationChunks)
    .where(
      and(
        eq(bulkOperationChunks.operationId, operationId),
        isNull(bulkOperationChunks.appliedAt),
        gt(bulkOperationChunks.chunkIndex, afterIndex),
      ),
    )
    .orderBy(bulkOperationChunks.chunkIndex)
    .limit(1);
  return row;
};
