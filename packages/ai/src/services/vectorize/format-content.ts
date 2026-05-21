import type { DocumentVectorMetadata } from "@fretik/shared/db/schema";

/**
 * Stringify a primitive (or array of primitives) for inclusion in the
 * semantic header / metadata-only text. `null` / `undefined` skip the
 * field; arrays are joined with comma to keep the header compact.
 */
const formatScalar = (
  value: string | number | boolean | string[] | null | undefined,
): string | null => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.filter((v) => v != null && v !== "").join(", ");
    return joined.length > 0 ? joined : null;
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  return String(value);
};

/**
 * Builds a single-line semantic header prepended to each chunk's
 * `contextual_prefix` before embedding + BM25 indexing.
 *
 * Team-configurable fields ride through `metadata.custom_fields` as raw
 * `{ key: value }` pairs (already pre-filtered by the caller to fields
 * whose definition has `vectorizeInclude=true`). Keys are emitted as-is:
 * they are already descriptive (`document_type`, `invoice_number`, …)
 * and both cosine similarity and BM25 handle snake_case well — no need
 * to round-trip via the field definitions for label lookup.
 */
export const buildSemanticHeader = (
  metadata: DocumentVectorMetadata,
): string => {
  const parts: string[] = [`Document: ${metadata.file_name || "unknown"}`];
  for (const [key, value] of Object.entries(metadata.custom_fields ?? {})) {
    const formatted = formatScalar(value);
    if (formatted !== null) parts.push(`${key}: ${formatted}`);
  }
  if (metadata.labels && metadata.labels.length > 0) {
    parts.push(`labels: ${metadata.labels.map((l) => l.name).join(", ")}`);
  }
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

  for (const [key, value] of Object.entries(metadata.custom_fields ?? {})) {
    const formatted = formatScalar(value);
    if (formatted !== null) lines.push(`${key}: ${formatted}`);
  }
  if (metadata.labels && metadata.labels.length > 0) {
    lines.push(`Labels: ${metadata.labels.map((l) => l.name).join(", ")}`);
  }
  for (const entity of metadata.entities) {
    lines.push(`${entity.role}: ${entity.name} (${entity.type})`);
  }

  return lines.join("\n");
};
