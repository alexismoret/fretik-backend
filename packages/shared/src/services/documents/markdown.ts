/**
 * Helpers for the document markdown storage format.
 *
 * Storage format: `documentProperties.markdown` holds a JSON-stringified
 * array of page objects produced by the pre-extraction pipeline:
 *
 *   [{ "index": 0, "markdown": "…" }, { "index": 1, "markdown": "…" }]
 *
 * Why JSON and not plain markdown? The extraction workflow
 * (`services/extractions/launch.ts`) and the extraction-config generator
 * (`services/extraction-configs/generate.ts`) both `JSON.parse` this
 * column to iterate over pages individually — they need the per-page
 * index for schema inference. Flattening to joined markdown would break
 * both flows.
 *
 * When sending the document content to the RAG vectoriser, however, we
 * want real markdown: the `splitMarkdown` chunker in `@fretik/ai` looks
 * for ATX headers (`# Heading`) and JSON syntax produces zero useful
 * chunks. `joinDocumentPagesMarkdown` parses the stored JSON and returns
 * the pages joined with page headers + horizontal-rule separators —
 * suitable input for Anthropic Contextual Retrieval chunking.
 */

export interface StoredDocumentPage {
  index: number;
  markdown: string;
}

/**
 * Parses the `documentProperties.markdown` column and returns the pages
 * joined into a single markdown string. Each page is prefixed with a
 * `## Page N` heading (1-based) and separated from the next by a
 * horizontal rule. Returns `null` when the column is null / empty /
 * malformed so the caller can distinguish "no content" from "zero
 * pages" and skip the vectorise call cleanly.
 *
 * Tolerates:
 *   - the historical shape with pages as `{ index, markdown }` (0-based
 *     indices — we render them 1-based).
 *   - the edge case where a page is missing the `markdown` field.
 *
 * Does NOT attempt to recover if the JSON itself is malformed — that
 * should never happen (we control the writer) and a hard failure is
 * preferable to silently indexing corrupt content.
 */
export const joinDocumentPagesMarkdown = (
  stored: string | null | undefined,
): string | null => {
  if (!stored) return null;

  let pages: unknown;
  try {
    pages = JSON.parse(stored);
  } catch {
    return null;
  }

  if (!Array.isArray(pages) || pages.length === 0) return null;

  const parts: string[] = [];
  for (const raw of pages) {
    if (raw === null || typeof raw !== "object") continue;
    const page = raw as Partial<StoredDocumentPage>;
    const md = typeof page.markdown === "string" ? page.markdown.trim() : "";
    if (md.length === 0) continue;
    const pageNumber =
      typeof page.index === "number" ? page.index + 1 : parts.length + 1;
    parts.push(`## Page ${pageNumber}\n\n${md}`);
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
};
