import { z } from "zod";

import { randomUUIDv7 } from "bun";
import { eq, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { extname } from "path";
import db from "../../db";
import { folders, teamSettings } from "../../db/schema";
import { aiVectors } from "../../db/schema/ai-vectors";
import {
  documentProperties,
  documents,
  type NewDocument,
  type NewDocumentProperties,
} from "../../db/schema/documents";
import { callAiService } from "../../lib/ai-service";
import {
  buildDocumentOriginalKey,
  buildDocumentSidecarKey,
  buildDocumentThumbnailKey,
  copyDocumentSidecar,
  uploadDocumentSidecar,
} from "../../lib/document-storage";
import { fileValidationError, throwHttpError } from "../../lib/errors";
import { deleteFilesFromS3, uploadToS3 } from "../../lib/s3";
import { emitUploadEvent } from "../../lib/upload-events";
import { preExtractionResponseSchema } from "../../schemas/pre-extraction";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  isImage,
  isPdf,
  isSpreadsheet,
} from "../../utils/mimeTypes";
import { matchAndLinkEntities } from "../entities/match";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { convertDocumentToPdf, convertFirstPageToPdf } from "./convert";
import { setDocumentFieldValues } from "./field-values";
import { joinDocumentPagesMarkdown } from "./markdown";
import { generateImageThumbnail, generatePdfThumbnail } from "./thumbnails";

// ==================== //
// CONFIGURATION        //
// ==================== //

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ==================== //
// TYPES                //
// ==================== //

interface FileMetadata {
  id: string;
  folderId: string | null;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  fileHash: string;
}

// ==================== //
// AI SERVICE RESPONSES //
// ==================== //

/**
 * @fretik/ai internal vectorisation response.
 */
const aiVectorizeResponseSchema = z.object({
  success: z.boolean(),
  stats: z
    .object({
      chunksProduced: z.number(),
      chunksEnriched: z.number(),
      rowsInserted: z.number(),
      rowsDropped: z.number(),
    })
    .optional(),
});

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
 * Uploads a single document: validates, inserts in DB with status 'uploading',
 * and returns the document immediately. Processing happens in background.
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

  const metadata: FileMetadata = {
    id: documentId,
    folderId: folderId ?? null,
    originalFilename: file.name,
    fileSize: file.size,
    mimeType,
    fileHash,
  };

  // 4. Insert document in DB (converting for non-PDF, uploading for PDF)
  const initialStatus = isPdf(file.type) ? "uploading" : "converting";
  const documentToInsert: NewDocument = {
    ...metadata,
    teamId,
    status: initialStatus,
    uploadedById: userId,
  };

  const [savedDocument] = await db.transaction(async (tx) => {
    const result = await tx
      .insert(documents)
      .values(documentToInsert)
      .returning();

    // Update storage + folder count
    const totalGo = metadata.fileSize / 1024 ** 3;
    await tx
      .update(teamSettings)
      .set({
        storageUsedGb: sql`${teamSettings.storageUsedGb} + ${totalGo}`,
      })
      .where(eq(teamSettings.teamId, teamId));

    if (folderId) {
      await tx
        .update(folders)
        .set({
          documentCount: sql`${folders.documentCount} + 1`,
        })
        .where(eq(folders.id, folderId));
    }

    return result;
  });

  if (!savedDocument) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to save document",
    });
  }

  // 5. Launch background processing (fire and forget)
  processDocument(metadata, buffer, organizationId, teamId).catch((err) => {
    console.error(
      `[Upload] Background processing failed for ${documentId}:`,
      err,
    );
  });

  return savedDocument;
};

/**
 * Background processing pipeline:
 * 1. Convert first page to PDF for thumbnailing (non-PDF / non-image)
 * 2. Upload original file + thumbnail to S3
 * 3. Fast-path: reuse pre-extraction + vectors of a prior upload with the
 *    same content hash
 * 4. Upload an ephemeral PDF conversion if the file isn't natively
 *    consumable by Mistral OCR (Word/PPT full doc, Excel/CSV first page)
 * 5. Call @fretik/ai `/internal/pre-extract` — OCR + structured LLM
 *    classification + entity extraction
 * 6. Persist results to `documentProperties`, link entities, kick off RAG
 *    vectorisation
 * 7. Update document status to 'ready'
 */
const processDocument = async (
  metadata: FileMetadata,
  buffer: Uint8Array,
  organizationId: string,
  teamId: string,
): Promise<void> => {
  const { id: documentId } = metadata;

  try {
    const sharedMetadata = {
      documentId,
      organizationId,
      teamId,
    };

    // Step 1: Convert first page to PDF if needed (ephemeral, not saved to S3)
    const isNativePdf = isPdf(metadata.mimeType);
    const isNativeImage = isImage(metadata.mimeType);
    let firstPagePdfBuffer: Uint8Array | null = null;

    if (!isNativePdf && !isNativeImage) {
      firstPagePdfBuffer = await convertFirstPageToPdf(
        buffer,
        extname(metadata.originalFilename),
      );

      // Update status to 'uploading' after conversion
      await db
        .update(documents)
        .set({ status: "uploading" })
        .where(eq(documents.id, documentId));

      emitUploadEvent({ documentId, status: "uploading" });
    }

    // Step 2: Upload original file + thumbnail in parallel
    const thumbnailBuffer = isNativeImage
      ? await generateImageThumbnail(buffer)
      : await generatePdfThumbnail(firstPagePdfBuffer ?? buffer);

    await Promise.all([
      uploadToS3({
        buffer,
        key: buildDocumentOriginalKey(documentId, metadata.originalFilename),
        contentType: metadata.mimeType,
        ...sharedMetadata,
      }),
      uploadToS3({
        buffer: thumbnailBuffer,
        key: buildDocumentThumbnailKey(documentId),
        contentType: "image/png",
        ...sharedMetadata,
      }),
    ]);

    // Update status to 'processing'
    await db
      .update(documents)
      .set({ status: "processing" })
      .where(eq(documents.id, documentId));

    emitUploadEvent({ documentId, status: "processing" });

    // Step 4: Check if a duplicate hash already has processing results
    const duplicateResult = await findExistingProcessingByHash(
      metadata.fileHash,
    );

    if (duplicateResult) {
      // Clone the source document's S3 sidecar onto the new id so
      // `read('drive/{newId}-...')` and the vectoriser see the same
      // markdown. No-op when the source has no sidecar (spreadsheet).
      await copyDocumentSidecar(duplicateResult.sourceDocumentId, documentId, {
        organizationId,
        teamId,
      });

      await db.transaction(async (tx) => {
        await tx.insert(documentProperties).values({
          ...duplicateResult.properties,
          documentId,
        });

        // Re-apply the source document's custom field values to the new
        // document. Values are validated against the team's current
        // definitions — keys that no longer exist on the target team are
        // skipped (defensive in case the two teams diverged).
        if (Object.keys(duplicateResult.customFieldValues).length > 0) {
          await setDocumentFieldValues({
            documentId,
            teamId,
            values: duplicateResult.customFieldValues,
            source: "ai_extraction",
            tx,
          });
        }

        // Copy vectors from the source document for RAG
        const existingVectors = await tx.query.aiVectors.findMany({
          where: {
            sourceType: "documents",
            sourceId: duplicateResult.sourceDocumentId,
          },
        });

        if (existingVectors.length > 0) {
          await tx.insert(aiVectors).values(
            existingVectors.map((v) => ({
              content: v.content,
              metadata: v.metadata,
              embedding: v.embedding,
              contextualPrefix: v.contextualPrefix,
              chunkIndex: v.chunkIndex,
              totalChunks: v.totalChunks,
              sourceType: "documents" as const,
              sourceId: documentId,
              teamId,
              organizationId,
            })),
          );
        }

        await tx
          .update(documents)
          .set({ status: "ready" })
          .where(eq(documents.id, documentId));
      });

      emitUploadEvent({ documentId, status: "ready" });
      return;
    }

    // Step 5: Pre-extraction via @fretik/ai.
    // Mistral OCR requires a PDF or an image — for Word/PPT we upload a
    // full PDF conversion, for spreadsheets a first-page PDF (to avoid
    // Gotenberg choking on 20-sheet Excel monsters), for PDF/image/text
    // we hand the pre-extract service nothing but the documentId — it
    // derives the original S3 key itself. Ephemeral conversions land
    // under an override key and are cleaned up in the `finally` below.
    const isDocumentSpreadsheet = isSpreadsheet(metadata.mimeType);
    const isDocumentPdf = isPdf(metadata.mimeType);
    const isDocumentImage = isImage(metadata.mimeType);
    const isDocumentTextPlain = metadata.mimeType === "text/plain";

    let preExtractMimeType = metadata.mimeType;
    let ephemeralPreExtractKey: string | null = null;

    if (isDocumentSpreadsheet) {
      // Excel / CSV → first-page PDF (reuse firstPagePdfBuffer generated
      // in Step 1 for thumbnailing). Never touch sheets beyond page 1.
      if (!firstPagePdfBuffer) {
        throw new Error(
          "Spreadsheet without first-page PDF buffer — Step 1 should have produced one",
        );
      }
      ephemeralPreExtractKey = `documents/${documentId}-preextract.pdf`;
      await uploadToS3({
        buffer: firstPagePdfBuffer,
        key: ephemeralPreExtractKey,
        contentType: "application/pdf",
        ...sharedMetadata,
        temporary: true,
      });
      preExtractMimeType = "application/pdf";
    } else if (!isDocumentPdf && !isDocumentImage && !isDocumentTextPlain) {
      // Word / PowerPoint (and any other supported editable format) →
      // full-document PDF conversion so the LLM sees every page.
      const fullPdfBuffer = await convertDocumentToPdf(
        buffer,
        extname(metadata.originalFilename),
      );
      ephemeralPreExtractKey = `documents/${documentId}-preextract.pdf`;
      await uploadToS3({
        buffer: fullPdfBuffer,
        key: ephemeralPreExtractKey,
        contentType: "application/pdf",
        ...sharedMetadata,
        temporary: true,
      });
      preExtractMimeType = "application/pdf";
    }
    // PDF / image / text-plain: no override; pre-extract derives the key.

    // Resolve the team's active field definitions so the pre-extract LLM
    // produces the right `customFields` shape. Empty defs → universal-only
    // extraction (still valid; the team can wire fields up later).
    const teamFieldDefinitions = await getFieldDefinitionsForTeam({
      teamId,
      resourceType: "document",
    });

    let preExtractResult: z.infer<typeof preExtractionResponseSchema>;
    try {
      preExtractResult = await callAiService(
        "/internal/pre-extract",
        {
          documentId,
          mimeType: preExtractMimeType,
          originalFilename: metadata.originalFilename,
          teamId,
          organizationId,
          fileHash: metadata.fileHash,
          fieldDefinitions: teamFieldDefinitions,
          ...(ephemeralPreExtractKey
            ? { overrideS3Key: ephemeralPreExtractKey }
            : {}),
        },
        preExtractionResponseSchema,
        { teamId, organizationId },
        { timeoutMs: 3 * 60 * 1000 },
      );
    } finally {
      if (ephemeralPreExtractKey) {
        const keyToDelete = ephemeralPreExtractKey;
        deleteFilesFromS3([keyToDelete]).catch((err: unknown) => {
          console.warn(
            `[Upload] Failed to delete ephemeral pre-extract key ${keyToDelete}:`,
            err,
          );
        });
      }
    }

    if (!preExtractResult.success) {
      throw new Error("Pre-extraction returned success=false");
    }

    // Step 6: Save processing results.
    //
    // OCR markdown lives on S3 as a flat `.md` sidecar — see
    // `buildDocumentSidecarKey` in `@fretik/shared/lib/document-storage`.
    // Spreadsheets (xlsx/csv) get no sidecar: their first-page PDF OCR
    // is tabular data, and the vectoriser already falls back to a
    // metadata-only embedding for those.
    const vectorContent = !isDocumentSpreadsheet
      ? joinDocumentPagesMarkdown(preExtractResult.pages)
      : null;

    if (vectorContent !== null) {
      await uploadDocumentSidecar(documentId, vectorContent, {
        documentId,
        organizationId,
        teamId,
      });
    }

    const propertiesToInsert: NewDocumentProperties = {
      documentId,
      pageCount: preExtractResult.pageCount,
      documentSummary: preExtractResult.documentSummary,
      documentLanguage: preExtractResult.documentLanguage,
      confidenceScore: preExtractResult.confidenceScore?.toString(),
    };

    await db.transaction(async (tx) => {
      await tx.insert(documentProperties).values(propertiesToInsert);

      // Persist LLM-produced custom field values keyed by definition slug.
      // Keys not declared on the team's defs are silently skipped (defensive
      // against LLM hallucinations).
      if (Object.keys(preExtractResult.customFields).length > 0) {
        await setDocumentFieldValues({
          documentId,
          teamId,
          values: preExtractResult.customFields,
          source: "ai_extraction",
          tx,
        });
      }

      await tx
        .update(documents)
        .set({ status: "ready" })
        .where(eq(documents.id, documentId));
    });

    // Step 7: Match and link entities from pre-extraction
    if (preExtractResult.entities.length > 0) {
      await matchAndLinkEntities({
        teamId,
        documentId,
        extractedEntities: preExtractResult.entities,
      });
    }

    // Step 8: Send document data to @fretik/ai for RAG vector storage (non-blocking).
    // Pull linked entities + labels in a single round-trip so the embedded
    // semantic header carries them.
    //
    // Custom field values ride along under `custom_fields`. We pre-filter
    // to fields whose definition has `vectorizeInclude=true` so vectorise
    // stays definition-agnostic — it just turns `{ key: value }` pairs
    // into "key: value" lines for the semantic header. Keys are already
    // descriptive (`document_type`, `document_date`, …) and embed well
    // both for cosine similarity and BM25; no label lookup needed.
    const docWithRelations = await db.query.documents.findFirst({
      where: { id: documentId },
      columns: { id: true },
      with: {
        documentEntities: { with: { entity: true } },
        labels: { columns: { id: true, name: true } },
      },
    });

    const entityVectorInfo = (docWithRelations?.documentEntities ?? [])
      .filter((de) => de.entity !== null)
      .map((de) => ({
        id: de.entity!.id,
        name: de.entity!.name,
        type: de.entity!.type,
        role: de.role,
      }));

    const labelVectorInfo = (docWithRelations?.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
    }));

    const vectorisableKeys = new Set(
      teamFieldDefinitions
        .filter((d) => d.vectorizeInclude && d.enabled)
        .map((d) => d.key),
    );
    const vectorisableCustomFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(preExtractResult.customFields)) {
      if (vectorisableKeys.has(key)) {
        vectorisableCustomFields[key] = value;
      }
    }

    // `vectorContent` was already computed above when uploading the
    // sidecar; `null` triggers the metadata-only branch of the
    // vectoriser (spreadsheets).

    try {
      const vectorResult = await callAiService(
        "/internal/vectorize",
        {
          sourceType: "documents",
          sourceId: documentId,
          content: vectorContent,
          metadata: {
            file_name: metadata.originalFilename,
            file_type: metadata.mimeType,
            page_count: preExtractResult.pageCount ?? null,
            document_language: preExtractResult.documentLanguage ?? null,
            document_summary: preExtractResult.documentSummary ?? null,
            entities: entityVectorInfo,
            labels: labelVectorInfo,
            custom_fields: vectorisableCustomFields,
          },
          teamId,
          organizationId,
        },
        aiVectorizeResponseSchema,
        { teamId, organizationId },
      );

      if (!vectorResult.success) {
        console.warn(
          `[Upload] AI service vector storage returned success=false for ${documentId}`,
        );
      }
    } catch (error) {
      console.error(
        `[Upload] AI service vector storage failed for ${documentId}:`,
        error,
      );
    }

    emitUploadEvent({ documentId, status: "ready" });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown processing error";

    console.error(
      `[Upload] Processing failed for ${documentId}:`,
      errorMessage,
    );

    await db
      .update(documents)
      .set({ status: "error", errorMessage })
      .where(eq(documents.id, documentId));

    if (metadata.folderId) {
      await db
        .update(folders)
        .set({
          documentCount: sql`${folders.documentCount} - 1`,
        })
        .where(eq(folders.id, metadata.folderId));
    }

    // Decrement storage and cleanup S3 files
    await db.transaction(async (tx) => {
      const totalGo = metadata.fileSize / 1024 ** 3;
      await tx
        .update(teamSettings)
        .set({
          storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} - ${totalGo})`,
        })
        .where(eq(teamSettings.teamId, teamId));

      // Cleanup S3 files (original + thumbnail + any partial sidecar).
      // No-op for sidecars that were never written.
      await deleteFilesFromS3([
        buildDocumentOriginalKey(documentId, metadata.originalFilename),
        buildDocumentThumbnailKey(documentId),
        buildDocumentSidecarKey(documentId),
      ]);
    });

    emitUploadEvent({ documentId, status: "error", error: errorMessage });
  }
};

/**
 * Finds an existing documentProperty from a document with the same hash and
 * status 'ready'. Returns universal properties, the source document ID (for
 * vector duplication) AND the custom field values keyed by definition slug
 * so the new document inherits them.
 */
const findExistingProcessingByHash = async (
  fileHash: string,
): Promise<{
  properties: Omit<NewDocumentProperties, "documentId">;
  sourceDocumentId: string;
  customFieldValues: Record<string, unknown>;
} | null> => {
  const existing = await db.query.documentProperties.findFirst({
    where: {
      document: {
        fileHash,
        status: "ready",
      },
      // Fetch the full document so we can join its custom field values
      // in the same round-trip.
    },
    with: {
      document: {
        columns: { id: true },
        with: {
          fieldValues: {
            columns: { fieldKey: true, value: true },
          },
        },
      },
    },
  });

  if (!existing) return null;

  const customFieldValues: Record<string, unknown> = {};
  for (const fv of existing.document?.fieldValues ?? []) {
    customFieldValues[fv.fieldKey] = fv.value;
  }

  return {
    sourceDocumentId: existing.documentId,
    properties: {
      pageCount: existing.pageCount,
      documentSummary: existing.documentSummary,
      documentLanguage: existing.documentLanguage,
      confidenceScore: existing.confidenceScore,
    },
    customFieldValues,
  };
};
