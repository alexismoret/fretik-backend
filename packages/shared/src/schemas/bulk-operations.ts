import { z } from "@hono/zod-openapi";
import { MAX_BULK_ITEMS } from "../lib/db-bulk";
import { MAX_BULK_OPERATION_ITEMS } from "../services/bulk-operations/begin";

/**
 * The wire shapes of a bulk record write over HTTP.
 *
 * Two doors, and the difference between them is the size of the load, not what
 * it does:
 *
 *  - `/collection-records/bulk` — one request, one answer, up to
 *    `MAX_BULK_ITEMS` rows. The ordinary bulk write an application makes.
 *  - `/collection-records/bulk-operations` + `/chunks` + `/commit` — a load too
 *    large for a single body, uploaded against a ledger row and resumable. The
 *    same three steps the sandbox SDK takes, opened to any client.
 *
 * Both are the caller's OWN writes, under their session: no approval card, no
 * assistant policy. Those gate what the agent may do on someone's behalf, and
 * an application calling with a user's credentials is that user writing.
 */

/** What a bulk write does. The union's discriminant on every shape below. */
const bulkRecordOpSchema = z.enum(["create", "update", "delete"]);

const rowData = z.record(z.string(), z.unknown());

export const bulkRecordWriteRequestSchema = z
  .discriminatedUnion("op", [
    z.object({
      op: z.literal("create"),
      collectionId: z.uuid(),
      rows: z.array(rowData).min(1).max(MAX_BULK_ITEMS),
    }),
    z.object({
      op: z.literal("update"),
      collectionId: z.uuid(),
      updates: z
        .array(z.object({ id: z.uuid(), data: rowData }))
        .min(1)
        .max(MAX_BULK_ITEMS),
      /** Patch the provided keys (default) instead of replacing the row. */
      merge: z.boolean().default(true),
    }),
    z.object({
      op: z.literal("delete"),
      collectionId: z.uuid(),
      ids: z.array(z.uuid()).min(1).max(MAX_BULK_ITEMS),
    }),
  ])
  .openapi("BulkRecordWriteRequest");

export const bulkRecordWriteResponseSchema = z
  .object({
    okCount: z.number().int(),
    /** New ids for a create, aligned with `rows`; `null` where a row failed. */
    ids: z.array(z.string().nullable()).optional(),
    updatedIds: z.array(z.string()).optional(),
    deletedIds: z.array(z.string()).optional(),
    /** Per-row failures. Keyed by position for a create, by id otherwise. */
    errors: z
      .array(
        z.object({
          index: z.number().int().optional(),
          id: z.string().optional(),
          error: z.string(),
        }),
      )
      .default([]),
  })
  .openapi("BulkRecordWriteResponse");

/**
 * `rowsDigest` is the caller's hash of the rows it is about to send, and it is
 * what makes a re-submission cheap: the same description plus the same digest
 * resolves to the same ledger row, so a client that lost its connection
 * mid-upload re-runs the identical call and is told which chunks to skip. A
 * description WITHOUT it would match any other load of the same size into the
 * same collection, and a corrected re-run would silently replay the old one.
 */
export const beginBulkOperationRequestSchema = z
  .object({
    op: bulkRecordOpSchema,
    collectionId: z.uuid(),
    totalRows: z.number().int().min(1).max(MAX_BULK_OPERATION_ITEMS),
    rowsDigest: z.string().min(16).max(128),
    sample: z.array(rowData).max(10).default([]),
    columns: z.array(z.string()).max(200).optional(),
    merge: z.boolean().optional(),
  })
  .openapi("BeginBulkOperationRequest");

export const bulkOperationResponseSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    totalItems: z.number().int(),
    /** Rows the caller must put in each chunk — sized from the collection. */
    chunkRows: z.number().int(),
    /** Chunk indexes already accounted for; a resumed caller skips exactly
     * these. Empty on a first submission. */
    doneChunks: z.array(z.number().int()),
    okCount: z.number().int().optional(),
    failedCount: z.number().int().optional(),
    errorCount: z.number().int().optional(),
    errors: z
      .array(z.object({ index: z.number().int(), error: z.string() }))
      .optional(),
    error: z.string().nullable().optional(),
  })
  .openapi("BulkOperationResponse");

/** Rows per chunk request — the same ceiling the sandbox upload uses. */
export const MAX_BULK_OPERATION_CHUNK_ROWS = 5000;

export const bulkOperationChunkRequestSchema = z
  .object({
    chunkIndex: z.number().int().min(0),
    rows: z.array(rowData).min(1).max(MAX_BULK_OPERATION_CHUNK_ROWS),
  })
  .openapi("BulkOperationChunkRequest");

export const bulkOperationChunkResponseSchema = z
  .object({
    applied: z.number().int(),
    okCount: z.number().int(),
    ids: z.array(z.string().nullable()).default([]),
    errors: z
      .array(z.object({ index: z.number().int(), error: z.string() }))
      .default([]),
  })
  .openapi("BulkOperationChunkResponse");
