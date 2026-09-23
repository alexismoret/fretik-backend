import type { z } from "zod";
import db from "../../db";
import type { BulkOperation, BulkOperationParams } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { beginBulkOperationRequestSchema } from "../../schemas/bulk-operations";
import { ERROR_CODES } from "../../schemas/errors";
import { recordImportLookupHash } from "../approvals/hash";
import { recordWriteChunkSize } from "../collection-records/bulk-create";
import { recordUpdateChunkSize } from "../collection-records/bulk-update";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { beginBulkOperation, type BulkOperationHandle } from "./begin";
import { applyChunk, chunkAlreadyApplied, claimChunk } from "./chunk";
import { commitBulkOperation } from "./commit";
import { firstMalformedRow } from "./executors/rows";
import { findBulkOperation } from "./find";
import { emptyProgress, foldChunkProgress } from "./progress";
import { updateBulkOperationProgress } from "./runner";
import type { ChunkOutcome } from "./types";

/**
 * A streamed load opened over HTTP rather than from a conversation.
 *
 * The same three steps the sandbox SDK takes — announce, upload, commit —
 * against the same ledger, with two differences that both come from there
 * being nobody to ask:
 *
 *  - the mode is always `direct`. `staged` exists to park rows in front of a
 *    human, and the human it parks them for is the one talking to the
 *    assistant. An application calling with a user's session IS that user
 *    writing, exactly as on `POST /collection-records`;
 *  - the scope is the TEAM. The sandbox additionally pins an operation to its
 *    conversation, because the id travels through agent-written code and one
 *    turn must not extend another's load. An API client holds its own id.
 */

const LOAD_KINDS = {
  create: "record_import",
  update: "record_update",
  delete: "record_delete",
} as const;

type BeginInput = z.infer<typeof beginBulkOperationRequestSchema> & {
  organizationId: string;
  teamId: string;
  userId: string;
};

/** What the caller needs to start (or resume) uploading. */
export interface ApiLoadHandle {
  operation: BulkOperation;
  chunkRows: number;
  doneChunks: number[];
}

export const beginApiLoad = async (
  input: BeginInput,
): Promise<ApiLoadHandle> => {
  const collection = await assertTeamCollection(input);
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    collectionId: input.collectionId,
  });
  // One chunk is one transaction of the target collection — see `chunk.ts`.
  const chunkSize =
    input.op === "update"
      ? recordUpdateChunkSize(fieldDefs)
      : recordWriteChunkSize(fieldDefs);

  const merge = input.op === "update" ? (input.merge ?? true) : undefined;
  const params: BulkOperationParams =
    input.op === "update"
      ? {
          op: "update",
          collectionId: input.collectionId,
          collectionKey: collection.key,
          merge: merge ?? true,
        }
      : input.op === "delete"
        ? {
            op: "delete",
            collectionId: input.collectionId,
            collectionKey: collection.key,
          }
        : {
            op: "create",
            collectionId: input.collectionId,
            collectionKey: collection.key,
          };

  const handle: BulkOperationHandle = await beginBulkOperation({
    organizationId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
    kind: LOAD_KINDS[input.op],
    mode: "direct",
    lookupHash: recordImportLookupHash({
      op: input.op,
      collectionId: input.collectionId,
      totalRows: input.totalRows,
      rowsDigest: input.rowsDigest,
      ...(merge === undefined ? {} : { merge }),
    }),
    totalItems: input.totalRows,
    chunkSize,
    params,
    sample: input.sample,
    ...(input.columns ? { columns: input.columns } : {}),
  });

  return {
    operation: handle.operation,
    chunkRows: handle.operation.chunkSize,
    doneChunks: handle.doneChunks,
  };
};

/**
 * The wire shape of a load — the same one at every step, so a client polls,
 * resumes and finishes against one object rather than three.
 *
 * `chunkRows` and `doneChunks` are what the caller ACTS on; the counters are
 * only present once there is a tally to give. A load still moving reports no
 * counts rather than zeroes, for the reason `importToolOutput` states: `okCount
 * 0` beside `status: "running"` reads as "nothing landed".
 */
export const serializeApiLoad = (
  operation: BulkOperation,
  doneChunks: number[],
): {
  id: string;
  kind: string;
  status: string;
  totalItems: number;
  chunkRows: number;
  doneChunks: number[];
  okCount?: number;
  failedCount?: number;
  errorCount?: number;
  errors?: { index: number; error: string }[];
  error?: string | null;
} => ({
  id: operation.id,
  kind: operation.kind,
  status: operation.status,
  totalItems: operation.totalItems,
  chunkRows: operation.chunkSize,
  doneChunks,
  ...(operation.progress === null
    ? {}
    : {
        okCount: operation.progress.succeeded,
        failedCount: operation.progress.failed,
        errorCount: operation.progress.errorCount,
        errors: operation.progress.errors,
      }),
  error: operation.error,
});

/** The operation, if it is this team's. The id alone proves nothing. */
export const findTeamBulkOperation = async (
  operationId: string,
  teamId: string,
): Promise<BulkOperation> => {
  const row = await findBulkOperation(operationId);
  if (row === undefined || row.teamId !== teamId) {
    return throwHttpError(404, notFound("Bulk operation"));
  }
  return row;
};

export const uploadApiChunk = async (input: {
  operation: BulkOperation;
  chunkIndex: number;
  rows: Record<string, unknown>[];
}): Promise<ChunkOutcome & { applied: number }> => {
  const { operation } = input;
  if (operation.status !== "staging") {
    return throwHttpError(409, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Bulk operation ${operation.id} is ${operation.status} and no longer accepts rows.`,
    });
  }

  // Refused whole, before the ledger records a thing: a chunk of the wrong
  // shape is a mistake the caller can still fix, and half-storing it would
  // turn it into a report of 2 000 failed rows instead.
  const malformed = firstMalformedRow(operation.kind, input.rows);
  if (malformed !== null) {
    return throwHttpError(400, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Row ${(input.chunkIndex * operation.chunkSize + malformed.index).toString()} is not ${malformed.shape}, which is what a ${operation.params.op} load carries. No chunk was stored.`,
    });
  }

  const chunk = await claimChunk({
    operationId: operation.id,
    chunkIndex: input.chunkIndex,
    itemCount: input.rows.length,
  });
  // A chunk the caller is SENDING AGAIN. `applyChunk` refuses to write it
  // twice, but the running tally is a separate fold and would count it twice.
  const replayed = chunkAlreadyApplied(chunk);
  const outcome = await applyChunk({ operation, chunk, items: input.rows });
  if (!replayed) {
    const current = await findBulkOperation(operation.id);
    if (current !== undefined) {
      await updateBulkOperationProgress(
        operation.id,
        foldChunkProgress(
          current.progress ?? emptyProgress(),
          outcome,
          chunk.chunkIndex * current.chunkSize,
        ),
      );
    }
  }
  return { ...outcome, applied: chunk.chunkIndex };
};

/** Close the upload. Always the `direct` branch — see the module docblock. */
export const commitApiLoad = async (
  operation: BulkOperation,
): Promise<BulkOperation> => {
  const response = await commitBulkOperation({ operation });
  if (response.status !== "ok") {
    return throwHttpError(409, {
      code: ERROR_CODES.VALIDATION_ERROR,
      message:
        response.status === "error"
          ? response.message
          : `Bulk operation ${operation.id} is waiting on something this route cannot resolve.`,
    });
  }
  const finished = await findBulkOperation(operation.id);
  return finished ?? operation;
};

/**
 * The target collection, refused unless it is the caller's team's.
 *
 * Separate from the write services' own ownership checks on purpose: those
 * answer "is this ROW mine", and a load announces its target before it has
 * sent a single row. Without this, a client could open a load — and size its
 * chunks — against another team's collection, and only find out at the first
 * chunk, having already put a ledger row in someone else's tenancy.
 */
const assertTeamCollection = async (input: {
  teamId: string;
  collectionId: string;
}): Promise<{ key: string }> => {
  const collection = await db.query.collections.findFirst({
    columns: { key: true, teamId: true },
    where: { id: input.collectionId },
  });
  if (collection === undefined || collection.teamId !== input.teamId) {
    return throwHttpError(404, notFound("Collection"));
  }
  return { key: collection.key };
};
