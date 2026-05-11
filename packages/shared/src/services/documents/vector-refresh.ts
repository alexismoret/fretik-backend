import { z } from "zod";

import db from "../../db";
import type { DocumentVectorMetadata } from "../../db/schema/ai-vectors";
import { callAiService } from "../../lib/ai-service";
import { joinDocumentPagesMarkdown } from "./markdown";

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

/**
 * Builds the full metadata JSON for a document's vectors.
 * Fetches document, properties, and linked entities.
 */
const buildDocumentVectorMetadata = async (
  documentId: string,
): Promise<{
  metadata: DocumentVectorMetadata;
  markdown: string | null;
} | null> => {
  const document = await db.query.documents.findFirst({
    where: { id: documentId },
    with: {
      properties: true,
      documentEntities: {
        with: { entity: true },
      },
    },
  });

  if (!document || document.status !== "ready") {
    return null;
  }

  const properties = document.properties;

  const entities = document.documentEntities
    .filter((de) => de.entity !== null)
    .map((de) => ({
      id: de.entity!.id,
      name: de.entity!.name,
      type: de.entity!.type,
      role: de.role,
    }));

  const metadata: DocumentVectorMetadata = {
    file_name: document.originalFilename,
    file_type: document.mimeType,
    page_count: properties?.pageCount ?? null,
    document_type: properties?.documentType ?? null,
    document_transport_type: properties?.documentTransportType ?? null,
    document_language: properties?.documentLanguage ?? null,
    document_summary: properties?.documentSummary ?? null,
    document_date: properties?.documentDate?.toISOString() ?? null,
    document_number: properties?.documentNumber ?? null,
    transport_mode: properties?.transportMode ?? null,
    entities,
  };

  return {
    metadata,
    markdown: properties?.markdown ?? null,
  };
};

/**
 * Triggers a vector refresh (upsert) for a specific document.
 * Fetches current metadata + markdown and hands off the full
 * chunk → enrich → embed → upsert pipeline to `@fretik/ai`'s
 * `POST /internal/vectorize` endpoint. The endpoint DELETEs existing
 * vectors for this source before re-inserting, so the call is idempotent.
 *
 * Fire-and-forget: errors are logged but not thrown.
 */
export const triggerDocumentVectorRefresh = async (
  documentId: string,
  teamId: string,
  organizationId: string,
): Promise<void> => {
  try {
    const result = await buildDocumentVectorMetadata(documentId);

    if (!result) {
      console.warn(
        `[VectorRefresh] Document ${documentId} not found or not ready, skipping`,
      );
      return;
    }

    // Parse the stored JSON pages and join them into real markdown for
    // the chunker. `null` (Excel / CSV) triggers the metadata-only
    // vectorise branch in `@fretik/ai` — so unlike the historical
    // behaviour that silently skipped spreadsheets, they now get an
    // embedded metadata record and become searchable.
    const vectorContent = joinDocumentPagesMarkdown(result.markdown);

    const vectorResult = await callAiService(
      "/internal/vectorize",
      {
        sourceType: "documents",
        sourceId: documentId,
        content: vectorContent,
        metadata: result.metadata,
        teamId,
        organizationId,
      },
      aiVectorizeResponseSchema,
      { teamId, organizationId },
    );

    if (!vectorResult.success) {
      console.warn(
        `[VectorRefresh] AI service returned success=false for document ${documentId}`,
      );
    }
  } catch (error) {
    console.error(`[VectorRefresh] Failed for document ${documentId}:`, error);
  }
};

/**
 * Triggers vector refresh for all documents linked to a specific entity.
 * Used when an entity is updated, merged, or its document links change.
 *
 * Fire-and-forget: errors are logged per document but not thrown.
 */
export const triggerEntityDocumentsVectorRefresh = async (
  entityId: string,
  teamId: string,
  organizationId: string,
): Promise<void> => {
  try {
    const documentEntities = await db.query.documentEntities.findMany({
      where: { entityId },
      columns: { documentId: true },
    });

    const uniqueDocumentIds = [
      ...new Set(documentEntities.map((de) => de.documentId)),
    ];

    for (const docId of uniqueDocumentIds) {
      await triggerDocumentVectorRefresh(docId, teamId, organizationId);
    }
  } catch (error) {
    console.error(
      `[VectorRefresh] Failed to refresh documents for entity ${entityId}:`,
      error,
    );
  }
};
