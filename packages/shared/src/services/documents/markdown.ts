/**
 * Helpers for the document markdown storage format.
 *
 * The OCR markdown for a document is stored on S3 as a flat `.md`
 * sidecar — see `buildDocumentSidecarKey` in
 * `@fretik/shared/lib/document-storage`. The pre-extraction pipeline
 * returns pages as `{ index, markdown }[]`; this module joins them
 * into the final flat form once, at write time, with `## Page N`
 * headings (1-based) and `---` separators between pages — suitable
 * input for the `splitMarkdown` chunker in `@fretik/ai`.
 *
 * Spreadsheets get no sidecar (their first-page PDF OCR is tabular
 * data unsuitable for prose chunking); the vectoriser already falls
 * back to a metadata-only embedding for those.
 */

export interface StoredDocumentPage {
  index: number;
  markdown: string;
}

/**
 * Joins the per-page markdown into a single flat markdown string.
 * Each page is prefixed with a `## Page N` heading (1-based) and
 * separated from the next by a horizontal rule. Returns `null` when
 * the input is empty / has no usable pages so the caller can
 * distinguish "no content" from "zero pages" and skip the sidecar
 * write + the vectorise call cleanly.
 *
 * Tolerates pages missing the `markdown` field; uses positional
 * numbering when `index` is missing or not numeric.
 */
export const joinDocumentPagesMarkdown = (
  pages: ReadonlyArray<StoredDocumentPage> | null | undefined,
): string | null => {
  if (!pages || pages.length === 0) return null;

  const parts: string[] = [];
  for (const raw of pages) {
    if (raw === null || typeof raw !== "object") continue;
    const md = typeof raw.markdown === "string" ? raw.markdown.trim() : "";
    if (md.length === 0) continue;
    const pageNumber =
      typeof raw.index === "number" ? raw.index + 1 : parts.length + 1;
    parts.push(`## Page ${pageNumber}\n\n${md}`);
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
};
