import { z } from "zod";

import db from "../../db";
import type { DocumentVectorMetadata } from "../../db/schema/ai-vectors";
import { callAiService } from "../../lib/ai-service";
import { getDocumentSidecarBytes } from "../../lib/document-storage";
import { readRecordData } from "../collection-schema/record-io";
import { MENTIONS_LINK_TYPE_KEY } from "../collections/seed-system-types";
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
 * Universal AI outputs (page count, language, summary, entities)
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
      mirrorRecord: {
        columns: { id: true, collectionId: true },
        with: {
          outgoingLinks: {
            columns: { id: true },
            with: { toRecord: { columns: { id: true, label: true } } },
          },
        },
      },
    },
  });

  if (!document || document.status !== "ready") {
    return null;
  }

  const properties = document.properties;

  // Mentioned parties are now `company` records linked from the document mirror
  // via the generic `mentions` relation (the only document-outgoing link type).
  const entities = (document.mirrorRecord?.outgoingLinks ?? [])
    .map((l) => l.toRecord)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({
      id: r.id,
      name: r.label,
      type: "company",
      role: MENTIONS_LINK_TYPE_KEY,
    }));

  const definitions = await getFieldDefinitionsForTeam({
    teamId,
  });
  const vectorisableKeys = new Set(
    definitions.filter((d) => d.vectorizeInclude).map((d) => d.key),
  );
  const recordData = document.mirrorRecord
    ? await readRecordData({
        collectionId: document.mirrorRecord.collectionId,
        recordId: document.mirrorRecord.id,
        fields: definitions,
      })
    : {};
  const customFields: DocumentVectorMetadata["custom_fields"] = {};
  for (const [key, value] of Object.entries(recordData)) {
    if (!vectorisableKeys.has(key)) continue;
    customFields[key] = value as string | number | boolean | string[] | null;
  }

  return {
    file_name: document.originalFilename,
    file_type: document.mimeType,
    page_count: properties?.pageCount ?? null,
    document_language: properties?.documentLanguage ?? null,
    document_summary: properties?.documentSummary ?? null,
    entities,
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
 * THROWS BY DESIGN — the queue owns the retry. Its only caller is the
 * `document-vector-refresh` worker, which needs the throw to mark the job
 * failed and retry it. Swallowing here is what made `attempts` dead code: the
 * job always completed, so the backoff never ran and every failure was final.
 * From a mutation path call `scheduleDocumentVectorRefresh` instead — it is
 * best-effort by contract and gives you the debounce as well.
 */
export const triggerDocumentVectorRefresh = async (
  documentId: string,
  teamId: string,
  organizationId: string,
): Promise<void> => {
  const metadata = await buildDocumentVectorMetadata(documentId, teamId);

  // Not a failure: a document that is gone or not yet `ready` has nothing to
  // index, and retrying would not change that.
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

  // `success: false` means no rows were written. Warning and returning would
  // complete the job — the same dead retry, one level down.
  if (!vectorResult.success) {
    throw new Error(
      `Vectorize returned success=false for document ${documentId}`,
    );
  }
};
