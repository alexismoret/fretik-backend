import type { DocumentVectorMetadata } from "@fretik/shared/db/schema";

/**
 * Builds a single-line semantic header prepended to each chunk's
 * `contextual_prefix` before embedding + BM25 indexing.
 *
 * Why per-chunk: Anthropic Contextual Retrieval bumps recall by ~35% by
 * situating each chunk. Adding document-level metadata (file name, type,
 * entity names) to every chunk means queries like "invoices from CMA CGM"
 * match documents where those tokens exist only in the metadata, not in
 * the OCR text. Without this, an invoice whose OCR doesn't mention
 * "CMA CGM" but whose `entities` metadata does is invisible to semantic
 * search unless the caller filters on JSONB explicitly — which our
 * agent tools don't do.
 *
 * The header is prepended to every chunk's prefix so every vector
 * carries the signal, not just the first chunk.
 */
export const buildSemanticHeader = (
  metadata: DocumentVectorMetadata,
): string => {
  const parts: string[] = [
    `Document: ${metadata.file_name || "unknown"}`,
    `Type: ${metadata.document_type || "unknown"}`,
  ];
  if (metadata.document_transport_type)
    parts.push(`Transport: ${metadata.document_transport_type}`);
  if (metadata.transport_mode) parts.push(`Mode: ${metadata.transport_mode}`);
  if (metadata.document_date) parts.push(`Date: ${metadata.document_date}`);
  if (metadata.document_number)
    parts.push(`Number: ${metadata.document_number}`);
  for (const entity of metadata.entities) {
    parts.push(`${entity.role}: ${entity.name} (${entity.type})`);
  }
  return `[${parts.join(" | ")}]`;
};

/**
 * Builds a purely metadata-driven semantic text used when the source has
 * no OCR content suitable for RAG — currently Excel / CSV tabular files
 * whose pages are rendered tables rather than narrative text.
 *
 * Produces a single short chunk per document so the document still shows
 * up in hybrid search on queries like "rate sheet from CMA CGM for Q1
 * 2026". The summary is placed first (highest-weight field) because it
 * carries most of the semantic signal for tabular sources.
 */
export const buildMetadataOnlyText = (
  metadata: DocumentVectorMetadata,
): string => {
  const lines: string[] = [];

  if (metadata.document_summary) {
    lines.push(`Summary: ${metadata.document_summary}`);
  }
  lines.push(`File: ${metadata.file_name || "unknown"}`);
  lines.push(`File type: ${metadata.file_type || "unknown"}`);
  if (metadata.document_type)
    lines.push(`Document type: ${metadata.document_type}`);
  if (metadata.document_transport_type)
    lines.push(`Transport type: ${metadata.document_transport_type}`);
  if (metadata.transport_mode)
    lines.push(`Transport mode: ${metadata.transport_mode}`);
  if (metadata.document_date)
    lines.push(`Document date: ${metadata.document_date}`);
  if (metadata.document_number)
    lines.push(`Document number: ${metadata.document_number}`);
  for (const entity of metadata.entities) {
    lines.push(`${entity.role}: ${entity.name} (${entity.type})`);
  }

  return lines.join("\n");
};
