import { and, eq, ne, sql } from "drizzle-orm";
import { extname } from "node:path";
import { z } from "zod";

import db from "../../db";
import { folders, teamSettings } from "../../db/schema";
import { aiVectors } from "../../db/schema/ai-vectors";
import {
  documentProperties,
  documents,
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
import { deleteFilesFromS3, getObjectBytes, uploadToS3 } from "../../lib/s3";
import { emitUploadEvent } from "../../lib/upload-events";
import { preExtractionResponseSchema } from "../../schemas/pre-extraction";
import { isImage, isPdf, isSpreadsheet } from "../../utils/mimeTypes";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { readRecordData } from "../object-schema/record-io";
import { MENTIONS_LINK_TYPE_KEY } from "../object-types/seed-system-types";
import { convertDocumentToPdf, convertFirstPageToPdf } from "./convert";
import { joinDocumentPagesMarkdown } from "./markdown";
import { syncDocumentGraph } from "./sync-document-graph";
import { generateImageThumbnail, generatePdfThumbnail } from "./thumbnails";

// ==================== //
// TYPES                //
// ==================== //

/**
 * Lightweight document metadata threaded through the processing job —
 * never carries the file bytes (those live on S3 under `originalKey`).
 */
export interface DocumentFileMetadata {
  id: string;
  folderId: string | null;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  fileHash: string;
}

/**
 * BullMQ job payload for document processing. Bytes are fetched from S3
 * by the worker — Redis only ever sees this small descriptor.
 */
export interface DocumentProcessingJobData {
  documentId: string;
  organizationId: string;
  teamId: string;
  /** S3 key of the original file, written by `uploadDocument` before enqueue. */
  originalKey: string;
  metadata: DocumentFileMetadata;
}

// ==================== //
// AI SERVICE RESPONSES //
// ==================== //

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
// PROCESSING PIPELINE  //
// ==================== //

/**
 * Document processing pipeline — runs inside a BullMQ worker, so it is
 * RETRY-SAFE: any throw lets BullMQ re-run the job (transient blip or a
 * crashed worker reclaim). Every persistence step is idempotent
 * (`documentProperties` upsert, `syncDocumentGraph` upserts the 1:1 mirror
 * record + dedups links + dedups `document.uploaded` on its dedupKey, vectorise
 * deletes by source first), so a re-run after partial progress converges cleanly.
 *
 * Steps:
 * 1. Fetch the original bytes from S3 (`originalKey`).
 * 2. Convert first page to PDF for thumbnailing (non-PDF / non-image).
 * 3. Upload the thumbnail to S3 (the original was already stored by the
 *    enqueueing caller).
 * 4. Fast-path: reuse pre-extraction + vectors of a prior upload with the
 *    same content hash.
 * 5. Upload an ephemeral PDF conversion when the file isn't natively
 *    consumable by Mistral OCR (Word/PPT full doc, Excel/CSV first page).
 * 6. Call @fretik/ai `/internal/pre-extract` — OCR + structured LLM
 *    classification + entity extraction.
 * 7. Persist results + mirror into the graph (`syncDocumentGraph`), mark ready,
 *    then kick off RAG vectorisation.
 *
 * On unexpected failure it THROWS; the terminal failure handling
 * (status → error, storage refund, S3 cleanup) lives in
 * `finalizeFailedDocument`, invoked by the worker once retries are
 * exhausted.
 */
export const processDocument = async (
  job: DocumentProcessingJobData,
): Promise<void> => {
  const { metadata, organizationId, teamId, originalKey } = job;
  const { id: documentId } = metadata;

  // A retry of an already-completed job is a no-op — bail before redoing
  // OCR / vectorisation that already landed.
  const current = await db.query.documents.findFirst({
    columns: { status: true },
    where: { id: documentId },
  });
  if (current?.status === "ready") {
    emitUploadEvent({ documentId, status: "ready" });
    return;
  }

  const sharedMetadata = {
    documentId,
    organizationId,
    teamId,
  };

  // Step 1: Fetch the original bytes from S3 (written before enqueue).
  const buffer = await getObjectBytes(originalKey);
  if (!buffer) {
    throw new Error(
      `Original file missing from S3 for ${documentId} (key ${originalKey})`,
    );
  }

  // Step 2: Convert first page to PDF if needed (ephemeral, not saved to S3)
  const isNativePdf = isPdf(metadata.mimeType);
  const isNativeImage = isImage(metadata.mimeType);
  let firstPagePdfBuffer: Uint8Array | null = null;

  if (!isNativePdf && !isNativeImage) {
    firstPagePdfBuffer = await convertFirstPageToPdf(
      buffer,
      extname(metadata.originalFilename),
    );

    await db
      .update(documents)
      .set({ status: "uploading" })
      .where(eq(documents.id, documentId));

    emitUploadEvent({ documentId, status: "uploading" });
  }

  // Step 3: Upload the thumbnail (original already on S3 under originalKey).
  const thumbnailBuffer = isNativeImage
    ? await generateImageThumbnail(buffer)
    : await generatePdfThumbnail(firstPagePdfBuffer ?? buffer);

  await uploadToS3({
    buffer: thumbnailBuffer,
    key: buildDocumentThumbnailKey(documentId),
    contentType: "image/webp",
    ...sharedMetadata,
  });

  await db
    .update(documents)
    .set({ status: "processing" })
    .where(eq(documents.id, documentId));

  emitUploadEvent({ documentId, status: "processing" });

  // Step 4: Reuse a prior upload's results when the content hash matches.
  const duplicateResult = await findExistingProcessingByHash(
    metadata.fileHash,
    documentId,
  );

  if (duplicateResult) {
    await copyDocumentSidecar(duplicateResult.sourceDocumentId, documentId, {
      organizationId,
      teamId,
    });

    await db.transaction(async (tx) => {
      await tx
        .insert(documentProperties)
        .values({ ...duplicateResult.properties, documentId })
        .onConflictDoUpdate({
          target: documentProperties.documentId,
          set: duplicateResult.properties,
        });

      // Mirror the inherited fields into the graph. No mentions: a content-hash
      // duplicate reuses the prior upload's results and skips entity extraction.
      await syncDocumentGraph({
        tx,
        organizationId,
        teamId,
        documentId,
        filename: metadata.originalFilename,
        customFields: duplicateResult.customFieldValues,
        mentions: [],
      });

      // The whole clone is one atomic transaction: a retry only re-enters
      // here when the prior attempt rolled back (status never reached
      // `ready`, guarded above), so no stale vectors can exist.
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

  // Step 5: Prepare the OCR-consumable input for pre-extraction.
  const isDocumentSpreadsheet = isSpreadsheet(metadata.mimeType);
  const isDocumentPdf = isPdf(metadata.mimeType);
  const isDocumentImage = isImage(metadata.mimeType);
  const isDocumentTextPlain = metadata.mimeType === "text/plain";

  let preExtractMimeType = metadata.mimeType;
  let ephemeralPreExtractKey: string | null = null;

  if (isDocumentSpreadsheet) {
    if (!firstPagePdfBuffer) {
      throw new Error(
        "Spreadsheet without first-page PDF buffer — Step 2 should have produced one",
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

  const teamFieldDefinitions = await getFieldDefinitionsForTeam({
    teamId,
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
          `[document-processing] Failed to delete ephemeral pre-extract key ${keyToDelete}:`,
          err,
        );
      });
    }
  }

  if (!preExtractResult.success) {
    throw new Error("Pre-extraction returned success=false");
  }

  // Step 6: Persist processing results (idempotent — safe on retry).
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

  const graphResult = await db.transaction(async (tx) => {
    await tx
      .insert(documentProperties)
      .values(propertiesToInsert)
      .onConflictDoUpdate({
        target: documentProperties.documentId,
        set: {
          pageCount: propertiesToInsert.pageCount,
          documentSummary: propertiesToInsert.documentSummary,
          documentLanguage: propertiesToInsert.documentLanguage,
          confidenceScore: propertiesToInsert.confidenceScore,
        },
      });

    // Mirror the document into the unified graph — 1:1 document record
    // (data = extracted custom fields), `mentions` links to resolved company
    // records, and the `document.uploaded` journal entry — all inside this
    // transaction. The slow/external steps (OCR above, vectorise + S3 below)
    // stay outside it so a Postgres tx is never held open across the network.
    const result = await syncDocumentGraph({
      tx,
      organizationId,
      teamId,
      documentId,
      filename: metadata.originalFilename,
      customFields: preExtractResult.customFields,
      mentions: preExtractResult.entities.map((e) => ({
        name: e.name,
        confidence: e.confidence,
      })),
    });

    await tx
      .update(documents)
      .set({ status: "ready" })
      .where(eq(documents.id, documentId));

    return result;
  });

  // Step 7: Send document data to @fretik/ai for RAG vector storage.
  // `/internal/vectorize` deletes existing rows for (sourceType, sourceId)
  // before inserting, so a retry replaces rather than duplicates.
  const docLabels = await db.query.documents.findFirst({
    where: { id: documentId },
    columns: { id: true },
    with: {
      labels: { columns: { id: true, name: true } },
    },
  });

  const mentionVectorInfo = graphResult.mentionedRecords.map((c) => ({
    id: c.id,
    name: c.name,
    type: graphResult.mentionTargetTypeKey,
    role: MENTIONS_LINK_TYPE_KEY,
  }));

  const labelVectorInfo = (docLabels?.labels ?? []).map((l) => ({
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
          entities: mentionVectorInfo,
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
        `[document-processing] AI service vector storage returned success=false for ${documentId}`,
      );
    }
  } catch (error) {
    // Vectorisation is best-effort — RAG can be re-indexed later; a failure
    // here must not fail the whole job (the document is already `ready`).
    console.error(
      `[document-processing] AI service vector storage failed for ${documentId}:`,
      error,
    );
  }

  emitUploadEvent({ documentId, status: "ready" });
};

/**
 * Terminal failure handling — invoked by the worker once BullMQ has
 * exhausted retries. Marks the document `error`, refunds the storage /
 * folder counters, and cleans up the S3 artefacts. Idempotent.
 *
 * Status-guarded: a document that already reached `ready` is left intact.
 * The pipeline commits `ready` (step 6) BEFORE the enrichment steps
 * (entity-linking, vectorise); if one of those throws on the final retry
 * the extraction itself succeeded, so the `ready` row and its S3 artefacts
 * must be preserved rather than destroyed.
 */
export const finalizeFailedDocument = async (
  job: DocumentProcessingJobData,
  errorMessage: string,
): Promise<void> => {
  const { metadata, teamId } = job;
  const { id: documentId } = metadata;

  const flipped = await db
    .update(documents)
    .set({ status: "error", errorMessage })
    .where(and(eq(documents.id, documentId), ne(documents.status, "ready")))
    .returning({ id: documents.id });

  // Already `ready` (or already gone) — nothing to refund or clean up.
  if (flipped.length === 0) return;

  if (metadata.folderId) {
    await db
      .update(folders)
      .set({ documentCount: sql`${folders.documentCount} - 1` })
      .where(eq(folders.id, metadata.folderId));
  }

  await db.transaction(async (tx) => {
    const totalGo = metadata.fileSize / 1024 ** 3;
    await tx
      .update(teamSettings)
      .set({
        storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} - ${totalGo})`,
      })
      .where(eq(teamSettings.teamId, teamId));

    await deleteFilesFromS3([
      buildDocumentOriginalKey(documentId, metadata.originalFilename),
      buildDocumentThumbnailKey(documentId),
      buildDocumentSidecarKey(documentId),
    ]);
  });

  emitUploadEvent({ documentId, status: "error", error: errorMessage });
};

/**
 * Finds an existing documentProperty from a `ready` document with the same
 * hash, excluding the document being processed. Returns universal
 * properties, the source document ID (for vector duplication) AND the
 * custom field values keyed by definition slug so the new document
 * inherits them.
 */
const findExistingProcessingByHash = async (
  fileHash: string,
  excludeDocumentId: string,
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
    },
    with: {
      document: {
        columns: { id: true, teamId: true },
        with: {
          mirrorRecord: { columns: { id: true, objectTypeId: true } },
        },
      },
    },
  });

  if (!existing) return null;
  // Guard against matching the document we're processing (e.g. on retry).
  if (existing.documentId === excludeDocumentId) return null;

  const mirror = existing.document?.mirrorRecord;
  const customFieldValues: Record<string, unknown> =
    mirror && existing.document
      ? await readRecordData({
          objectTypeId: mirror.objectTypeId,
          recordId: mirror.id,
          fields: await getFieldDefinitionsForTeam({
            teamId: existing.document.teamId,
            objectTypeId: mirror.objectTypeId,
          }),
        })
      : {};

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
