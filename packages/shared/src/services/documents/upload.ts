import { randomUUIDv7 } from "bun";
import { eq, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { extname } from "node:path";

import db from "../../db";
import { folders, teamSettings } from "../../db/schema";
import { documents, type NewDocument } from "../../db/schema/documents";
import { buildDocumentOriginalKey } from "../../lib/document-storage";
import { fileValidationError, throwHttpError } from "../../lib/errors";
import { uploadToS3 } from "../../lib/s3";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  isPdf,
} from "../../utils/mimeTypes";
import { type DocumentFileMetadata, finalizeFailedDocument } from "./process";
import { enqueueDocumentProcessing } from "./processing-queue";

// ==================== //
// CONFIGURATION        //
// ==================== //

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ==================== //
// VALIDATION           //
// ==================== //

/**
 * Validates a single uploaded file (type, size)
 */
const assertFile = (file: File): void => {
  const validationErrors: string[] = [];

  const extension = extname(file.name).toLowerCase();
  if (
    !ALLOWED_MIME_TYPES.includes(file.type) &&
    !ALLOWED_EXTENSIONS.includes(extension)
  ) {
    validationErrors.push(
      `${file.name}: Invalid type. Allowed formats: PDF, Word, Excel, CSV, PowerPoint, Text.`,
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    validationErrors.push(
      `${file.name}: File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
    );
  }

  if (validationErrors.length > 0) {
    throwHttpError(400, fileValidationError(validationErrors));
  }
};

// ==================== //
// MAIN EXPORTS         //
// ==================== //

/**
 * Inserts a `documents` row and bumps the team's storage / folder
 * counters in one transaction. Shared by the API upload route and the
 * chatbot Save-on-drive promotion. Does NOT enqueue processing — the
 * caller decides how the original bytes reach S3, then enqueues.
 */
export const createDocumentRecord = async (args: {
  metadata: DocumentFileMetadata;
  teamId: string;
  userId: string;
}): Promise<typeof documents.$inferSelect> => {
  const { metadata, teamId, userId } = args;

  const initialStatus = isPdf(metadata.mimeType) ? "uploading" : "converting";
  const documentToInsert: NewDocument = {
    id: metadata.id,
    folderId: metadata.folderId,
    originalFilename: metadata.originalFilename,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    fileHash: metadata.fileHash,
    teamId,
    status: initialStatus,
    uploadedById: userId,
  };

  const [savedDocument] = await db.transaction(async (tx) => {
    const result = await tx
      .insert(documents)
      .values(documentToInsert)
      .returning();

    const totalGo = metadata.fileSize / 1024 ** 3;
    await tx
      .update(teamSettings)
      .set({
        storageUsedGb: sql`${teamSettings.storageUsedGb} + ${totalGo}`,
      })
      .where(eq(teamSettings.teamId, teamId));

    if (metadata.folderId) {
      await tx
        .update(folders)
        .set({ documentCount: sql`${folders.documentCount} + 1` })
        .where(eq(folders.id, metadata.folderId));
    }

    return result;
  });

  if (!savedDocument) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to save document",
    });
  }

  return savedDocument;
};

/**
 * Uploads a single document: validates, persists the original to S3,
 * inserts the row (status `uploading`/`converting`) and enqueues the
 * processing job. Returns immediately — OCR / extraction / vectorisation
 * run in a BullMQ worker (see `processing-queue.ts`).
 *
 * The original is stored on S3 BEFORE the enqueue so the worker (any
 * replica) can fetch it; no file bytes ever transit Redis.
 */
export const uploadDocument = async (
  file: File,
  organizationId: string,
  teamId: string,
  userId: string,
  folderId: string | undefined,
): Promise<typeof documents.$inferSelect> => {
  // 1. Validate file
  assertFile(file);

  // 2. Read file into buffer + prepare metadata
  const documentId = randomUUIDv7();
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  const fileHash = Bun.SHA256.hash(arrayBuffer, "hex");

  let mimeType = file.type;
  if (!mimeType || mimeType.trim().length == 0) {
    const fileType = await fileTypeFromBuffer(buffer);
    mimeType = fileType?.mime ?? "application/pdf";
  }

  const metadata: DocumentFileMetadata = {
    id: documentId,
    folderId: folderId ?? null,
    originalFilename: file.name,
    fileSize: file.size,
    mimeType,
    fileHash,
  };

  // 3. Persist the original to S3 (durability boundary — done before the
  //    row is acked so the worker can always fetch the bytes).
  const originalKey = buildDocumentOriginalKey(
    documentId,
    metadata.originalFilename,
  );
  await uploadToS3({
    buffer,
    key: originalKey,
    contentType: mimeType,
    documentId,
    organizationId,
    teamId,
  });

  // 4. Insert the document row + bump counters.
  const savedDocument = await createDocumentRecord({
    metadata,
    teamId,
    userId,
  });

  // 5. Enqueue background processing. If the enqueue fails (Redis
  //    unreachable — the producer connection is fail-fast by design),
  //    don't leave the document stuck in a non-terminal state: refund
  //    storage, clean up S3 and surface a clear `error` to the user.
  try {
    await enqueueDocumentProcessing({
      documentId,
      organizationId,
      teamId,
      originalKey,
      metadata,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to enqueue processing";
    await finalizeFailedDocument(
      { documentId, organizationId, teamId, originalKey, metadata },
      message,
    );
    throw err;
  }

  return savedDocument;
};
