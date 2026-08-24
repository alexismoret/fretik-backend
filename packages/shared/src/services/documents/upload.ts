import { randomUUIDv7 } from "bun";
import { eq, sql } from "drizzle-orm";

import db, { type Transaction } from "../../db";
import { folders, teamSettings } from "../../db/schema";
import {
  documents,
  type DocumentSource,
  type DocumentStatus,
  type NewDocument,
} from "../../db/schema/documents";
import { thumbnailFor } from "../../file-types";
import { resolveFileType } from "../../file-types/detect";
import { buildDocumentOriginalKey } from "../../lib/document-storage";
import {
  createApiError,
  fileValidationError,
  throwHttpError,
} from "../../lib/errors";
import { uploadToS3 } from "../../lib/s3";
import { ERROR_CODES } from "../../schemas/errors";
import { findNameCollision, nextAvailableFilename } from "./name-collision";
import { type DocumentFileMetadata, finalizeFailedDocument } from "./process";
import { enqueueDocumentProcessing } from "./processing-queue";
import { replaceDocumentContent } from "./versions/replace-content";

// ==================== //
// CONFIGURATION        //
// ==================== //

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ==================== //
// VALIDATION           //
// ==================== //

/**
 * Validate one uploaded file and resolve its REAL type.
 *
 * The decision is made on the BYTES, never on the browser-supplied
 * `file.type` or the extension: both are trivially wrong (a `.txt` that
 * is really a PDF, an extensionless export, a mail client that labels
 * everything `application/octet-stream`). The MIME returned here is what
 * gets persisted, so every downstream router can trust it.
 */
const assertFile = async (file: File, bytes: Uint8Array): Promise<string> => {
  const validationErrors: string[] = [];

  const resolved = await resolveFileType({
    bytes,
    declaredMime: file.type,
    filename: file.name,
  });

  if (!resolved.type?.surfaces.includes("drive")) {
    validationErrors.push(
      `${file.name}: unsupported file type (${resolved.mimeType}).`,
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

  return resolved.mimeType;
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
  /**
   * `authored` for markdown written in-app — its bytes are the source of
   * truth, not an ingested artefact. Defaults to `uploaded`.
   */
  source?: DocumentSource;
  /**
   * Overrides the ingestion-derived starting status. The authored path passes
   * `ready`: nothing has to be converted, OCR'd or thumbnailed for the document
   * to be usable, so parking it in `converting` would only make it look broken
   * until a worker it never needs picked it up.
   */
  status?: DocumentStatus;
  /**
   * Enlist in a caller's transaction instead of opening one. Anything that
   * must land WITH the document row — its first version, say — passes its own
   * `tx` so a failure between the two cannot leave a document behind whose
   * provenance is gone.
   */
  tx?: Transaction;
}): Promise<typeof documents.$inferSelect> => {
  const { metadata, teamId, userId } = args;

  // `converting` means "a Gotenberg render stands between this file and a
  // usable thumbnail". Everything else — PDFs, images, text, code, mail —
  // goes straight to `uploading`.
  const thumbnail = thumbnailFor(metadata.mimeType, metadata.originalFilename);
  const needsRender =
    thumbnail === "libreoffice" || thumbnail === "chromium-screenshot";
  const initialStatus =
    args.status ?? (needsRender ? "converting" : "uploading");
  const documentToInsert: NewDocument = {
    id: metadata.id,
    folderId: metadata.folderId,
    originalFilename: metadata.originalFilename,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    fileHash: metadata.fileHash,
    teamId,
    status: initialStatus,
    source: args.source ?? "uploaded",
    uploadedById: userId,
  };

  const run = async (tx: Transaction) => {
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
  };

  const [savedDocument] = args.tx
    ? await run(args.tx)
    : await db.transaction(run);

  if (!savedDocument) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to save document",
    });
  }

  return savedDocument;
};

/**
 * How the upload path answers a same-name collision.
 *
 * `ask` refuses so the person decides — no file manager resolves this on your
 * behalf, and neither should we. The other two are the answers they give back.
 */
export type UploadConflictPolicy = "ask" | "replace" | "keepBoth";

export interface UploadDocumentResult {
  document: typeof documents.$inferSelect;
  /**
   * What actually happened, because it is not always "a new document":
   * `alreadyPresent` means these exact bytes were already filed under this
   * name, `replaced` means the existing document gained a version, and
   * `created` covers a fresh file and a `keepBoth` rename alike — the caller
   * reads `document.originalFilename` to see which name it ended up with.
   */
  outcome: "created" | "replaced" | "alreadyPresent";
  /** Set only for `replaced` — the version the previous content became. */
  versionNumber?: number;
}

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
  /**
   * What to do when the folder already holds a file with this name. `ask` (the
   * default) refuses with a 409 carrying the existing document's id, so the
   * caller can put the choice to the person who dropped the file — the same
   * thing every file manager does. Identical bytes never reach the question.
   */
  onConflict: UploadConflictPolicy = "ask",
): Promise<UploadDocumentResult> => {
  // 1. Read the file, then validate it against its actual content — the
  //    resolved MIME is what we persist.
  const documentId = randomUUIDv7();
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  const fileHash = Bun.SHA256.hash(arrayBuffer, "hex");

  const mimeType = await assertFile(file, buffer);

  // 2b. Same name, same folder — decide before any bytes move.
  const collision = await findNameCollision({
    teamId,
    folderId: folderId ?? null,
    filename: file.name,
    fileHash,
  });
  let filename = file.name;

  if (collision.kind === "identical") {
    // Already filed, byte for byte. Re-uploading it is not a new version and
    // not a second document; the honest answer is the one that is already there.
    const existing = await db.query.documents.findFirst({
      where: { id: collision.documentId, teamId },
    });
    if (existing) return { document: existing, outcome: "alreadyPresent" };
  } else if (collision.kind === "different") {
    if (onConflict === "ask") {
      return throwHttpError(
        409,
        createApiError(
          ERROR_CODES.DOCUMENT_NAME_CONFLICT,
          `A different file named "${file.name}" is already in this folder.`,
          collision.documentId,
        ),
      );
    }
    if (onConflict === "replace") {
      const result = await replaceDocumentContent({
        documentId: collision.documentId,
        teamId,
        organizationId,
        bytes: buffer,
        operation: "replace",
        actorContext: { actor: "human", userId },
        mimeType,
      });
      return {
        document: result.document,
        outcome: "replaced",
        versionNumber: result.version.versionNumber,
      };
    }
    filename = await nextAvailableFilename({
      teamId,
      folderId: folderId ?? null,
      filename: file.name,
    });
  }

  const metadata: DocumentFileMetadata = {
    id: documentId,
    folderId: folderId ?? null,
    originalFilename: filename,
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

  return { document: savedDocument, outcome: "created" };
};
