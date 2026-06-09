import { MISTRAL_OCR_MODEL, mistralClient } from "./mistral";

/**
 * Mistral OCR client — single entry point used by the documents
 * pre-extract pipeline, the chat-file preprocessor, and the
 * `ai_context_files` extractor (Projects-style context in the chatbot
 * system prompt).
 *
 * Mistral processes every page of a PDF in parallel server-side so
 * there is no per-page cost — we OCR the whole document and let the
 * caller decide which pages to forward. For images we use an
 * `image_url` chunk (1 page). For PDFs / DOCX / PPTX we use
 * `document_url` (Mistral OCR accepts these natively — no Gotenberg
 * conversion necessary for the chatbot-context path).
 */

export interface OcrPage {
  index: number;
  markdown: string;
}

export interface OcrResult {
  pages: OcrPage[];
  pageCount: number;
}

export interface RunOcrArgs {
  /** Presigned S3 URL reachable from Mistral's servers. */
  url: string;
  /** Original MIME type — determines document_url vs image_url chunk. */
  mimeType: string;
}

/**
 * Single Mistral OCR call. Returns every page verbatim; callers can
 * collapse to a single markdown blob via `flattenOcrMarkdown` when
 * they want a sidecar-friendly shape. `includeImageBase64: false` +
 * `imageLimit: 0` keeps the response payload small AND avoids the
 * DOCX/PPTX-specific 400 ("extracted images can only be returned in
 * base64") — Mistral rejects `includeImageBase64: false` for those
 * formats unless image extraction is disabled outright.
 */
export const runMistralOcr = async (args: RunOcrArgs): Promise<OcrResult> => {
  const isImage = args.mimeType.startsWith("image/");

  const response = await mistralClient.ocr.process({
    model: MISTRAL_OCR_MODEL,
    document: isImage
      ? { type: "image_url", imageUrl: args.url }
      : { type: "document_url", documentUrl: args.url },
    includeImageBase64: false,
    imageLimit: 0,
  });

  const pages: OcrPage[] = response.pages.map((p) => ({
    index: p.index,
    markdown: p.markdown,
  }));

  return {
    pages,
    pageCount: pages.length,
  };
};

/**
 * Collapse per-page OCR output into a single markdown string with a
 * readable page-break marker. Used by the chat-file preprocessor to
 * produce the `{basename}.md` sidecar the chatbot's `read` tool auto-
 * resolves to, and by the context extractor to fill
 * `ai_context_files.content`.
 */
export const OCR_PAGE_SEPARATOR = "\n\n---\n\n";

export const flattenOcrMarkdown = (result: OcrResult): string =>
  result.pages
    .map((p) => p.markdown)
    .filter((md) => md.length > 0)
    .join(OCR_PAGE_SEPARATOR);

/**
 * Inverse of `flattenOcrMarkdown`: reconstruct per-page markdown from a
 * flattened sidecar. Used on a content-addressed cache HIT so the Drive
 * pre-extract pipeline keeps its per-page down-selection without storing
 * a separate JSON artifact. The common Drive path (cache miss) uses the
 * exact pages from live OCR; this approximate split only runs on the
 * rarer cross-surface hit (file first OCR'd by chat/context). A stray
 * `---` thematic break inside a page can over-split, which is harmless
 * for down-selection (it still yields a representative head/tail sample).
 */
export const splitFlattenedMarkdown = (markdown: string): OcrPage[] =>
  markdown
    .split(OCR_PAGE_SEPARATOR)
    .map((md, index) => ({ index, markdown: md }));
