import { z } from "zod";

import db from "../../db";
import type { DocumentVectorMetadata } from "../../db/schema/ai-vectors";
import { callAiService } from "../../lib/ai-service";
import { getDocumentSidecarBytes } from "../../lib/document-storage";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";

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
 * Build the metadata JSON for a document's vectors.
 *
 * Universal AI outputs (page count, language, summary, entities, labels)
 * are emitted as named fields. Industry-specific outputs flow through
 * `custom_fields` keyed by the team's field definition slugs, pre-filtered
 * to `vectorizeInclude=true` so privacy-sensitive or internal fields
 * never reach the embedding store. Field definitions themselves are NOT
 * embedded — the chatbot reads them out-of-band via its own tool.
 */
const buildDocumentVectorMetadata = async (
  documentId: string,
  teamId: string,
): Promise<DocumentVectorMetadata | null> => {
  const document = await db.query.documents.findFirst({
    where: { id: documentId },
    with: {
      properties: true,
      documentEntities: { with: { entity: true } },
      labels: { columns: { id: true, name: true } },
      fieldValues: { columns: { fieldKey: true, value: true } },
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

  const labels = document.labels.map((l) => ({ id: l.id, name: l.name }));

  const definitions = await getFieldDefinitionsForTeam({
    teamId,
    resourceType: "document",
  });
  const vectorisableKeys = new Set(
    definitions.filter((d) => d.vectorizeInclude).map((d) => d.key),
  );
  const customFields: DocumentVectorMetadata["custom_fields"] = {};
  for (const fv of document.fieldValues) {
    if (!vectorisableKeys.has(fv.fieldKey)) continue;
    customFields[fv.fieldKey] = fv.value as
      | string
      | number
      | boolean
      | string[]
      | null;
  }

  return {
    file_name: document.originalFilename,
    file_type: document.mimeType,
    page_count: properties?.pageCount ?? null,
    document_language: properties?.documentLanguage ?? null,
    document_summary: properties?.documentSummary ?? null,
    entities,
    labels,
    custom_fields: customFields,
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
    const metadata = await buildDocumentVectorMetadata(documentId, teamId);

    if (!metadata) {
      console.warn(
        `[VectorRefresh] Document ${documentId} not found or not ready, skipping`,
      );
      return;
    }

    // Pull the OCR markdown from the S3 sidecar. `null` (spreadsheet,
    // or missing sidecar) triggers the metadata-only vectorise branch
    // in `@fretik/ai` — spreadsheets still become searchable via
    // their structured metadata embedding.
    const sidecarBytes = await getDocumentSidecarBytes(documentId);
    const vectorContent = sidecarBytes
      ? new TextDecoder().decode(sidecarBytes)
      : null;

    const vectorResult = await callAiService(
      "/internal/vectorize",
      {
        sourceType: "documents",
        sourceId: documentId,
        content: vectorContent,
        metadata,
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
