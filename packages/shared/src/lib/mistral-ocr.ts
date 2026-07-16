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
 *
 * Mistral Annotations (bbox / document annotations) were evaluated
 * 2026-07 and rejected: read/vision/python routing already covers
 * figure understanding and structured extraction without a second
 * schema-bound LLM pass, and document annotation is capped at 8 pages.
 * Revisit only if structured figure metadata becomes a product need.
 */

/**
 * Official Mistral OCR API limits (docs.mistral.ai) — revise if Mistral
 * changes them. Callers that know the byte size guard BEFORE calling
 * (`getOrCreateExtraction`); page count is only knowable after OCR, so
 * the page limit is enforced Mistral-side and surfaced as a clean error.
 */
export const MISTRAL_OCR_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MISTRAL_OCR_MAX_PAGES = 1000;

/**
 * Agent/user-readable message persisted when a document exceeds the
 * Mistral OCR limits — never a raw SDK error dump.
 */
export const MISTRAL_OCR_LIMIT_ERROR_MESSAGE = `Document exceeds Mistral OCR limits (${(MISTRAL_OCR_MAX_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB / ${MISTRAL_OCR_MAX_PAGES.toString()} pages) — split the file or process it with python.`;

/** Bounds for embedded-image extraction (`extractImages: true`). */
export const OCR_IMAGE_LIMIT = 12;
export const OCR_IMAGE_MIN_SIZE = 60;

export interface OcrPage {
  index: number;
  markdown: string;
}

/** One embedded image extracted by OCR, as raw base64 (no data: prefix). */
export interface OcrExtractedImage {
  /** Mistral-emitted id, e.g. `img-0.jpeg` — matches the markdown ref. */
  id: string;
  pageIndex: number;
  base64: string;
}

export interface OcrResult {
  pages: OcrPage[];
  pageCount: number;
  /** Always present; `[]` unless `extractImages` was requested. */
  images: OcrExtractedImage[];
}

export interface RunOcrArgs {
  /** Presigned S3 URL reachable from Mistral's servers. */
  url: string;
  /** Original MIME type — determines document_url vs image_url chunk. */
  mimeType: string;
  /**
   * Extract embedded images (documents only — callers skip it for the
   * `image-ocr` route, where crops of a photo are noise). Bounded by
   * OCR_IMAGE_LIMIT / OCR_IMAGE_MIN_SIZE. On any OCR error the call is
   * retried once without images so extraction never regresses.
   */
  extractImages?: boolean;
}

/** Strip an optional `data:<mime>;base64,` prefix from an SDK image payload. */
const stripDataUrlPrefix = (base64: string): string => {
  const commaIndex = base64.indexOf(",");
  return base64.startsWith("data:") && commaIndex !== -1
    ? base64.slice(commaIndex + 1)
    : base64;
};

const processOcr = async (args: RunOcrArgs, withImages: boolean) => {
  const isImage = args.mimeType.startsWith("image/");
  return mistralClient.ocr.process({
    model: MISTRAL_OCR_MODEL,
    document: isImage
      ? { type: "image_url", imageUrl: args.url }
      : { type: "document_url", documentUrl: args.url },
    // `includeImageBase64: false` + `imageLimit: 0` keeps the response
    // small AND avoids the DOCX/PPTX-specific 400 ("extracted images can
    // only be returned in base64") — Mistral rejects `includeImageBase64:
    // false` for those formats unless image extraction is disabled
    // outright. `true` + a bounded limit satisfies the same constraint.
    ...(withImages
      ? {
          includeImageBase64: true,
          imageLimit: OCR_IMAGE_LIMIT,
          imageMinSize: OCR_IMAGE_MIN_SIZE,
        }
      : { includeImageBase64: false, imageLimit: 0 }),
  });
};

/**
 * Single Mistral OCR call. Returns every page verbatim; callers can
 * collapse to a single markdown blob via `flattenOcrMarkdown` when
 * they want a sidecar-friendly shape.
 */
export const runMistralOcr = async (args: RunOcrArgs): Promise<OcrResult> => {
  const withImages = args.extractImages === true;

  let response: Awaited<ReturnType<typeof processOcr>>;
  try {
    response = await processOcr(args, withImages);
  } catch (error) {
    if (!withImages) throw error;
    // Image extraction must never make extraction worse than before it
    // existed: retry once with the legacy no-images combo, then let any
    // remaining error (size/page limits, auth, …) bubble to the caller.
    console.warn(
      `runMistralOcr: retrying without embedded images after error: ${error instanceof Error ? error.message : String(error)}`,
    );
    response = await processOcr(args, false);
    return {
      pages: response.pages.map((p) => ({
        index: p.index,
        markdown: p.markdown,
      })),
      pageCount: response.pages.length,
      images: [],
    };
  }

  const pages: OcrPage[] = response.pages.map((p) => ({
    index: p.index,
    markdown: p.markdown,
  }));

  const images: OcrExtractedImage[] = withImages
    ? response.pages.flatMap((page) =>
        page.images.flatMap((image) => {
          const base64 = image.imageBase64;
          if (typeof base64 !== "string" || base64.length === 0) return [];
          return [
            {
              id: image.id,
              pageIndex: page.index,
              base64: stripDataUrlPrefix(base64),
            },
          ];
        }),
      )
    : [];

  return {
    pages,
    pageCount: pages.length,
    images,
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
