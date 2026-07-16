import type { OcrPage, OcrResult, RunOcrArgs } from "../../lib/mistral-ocr";

/**
 * Content-addressed file extraction — the shared layer that turns an
 * uploaded file into model-readable markdown exactly once per
 * `(organizationId, fileHash)`, then serves it from cache to every
 * surface (chatbot `read`, Drive pre-extract, context files).
 *
 * The expensive routes (`mistral-ocr`, `image-ocr`, `spreadsheet`) are
 * cached in the `file_extractions` table + a single content-addressed
 * S3 `.md` sidecar (the same flattened markdown the agent reads — no
 * separate per-page JSON; page boundaries are reconstructed inline via
 * `splitFlattenedMarkdown` when needed). Embedded images extracted by
 * the `mistral-ocr` route are stored alongside the sidecar and listed
 * in `imageIds`. The cheap `text` route is parsed inline on every call
 * (no cache row) so callers can use one entry point for all MIME types.
 */

export type ExtractionRoute =
  | "mistral-ocr" // PDF / DOCX / PPTX → Mistral OCR (handles them natively)
  | "image-ocr" // image with usable OCR text
  | "image-skip" // image whose OCR yielded no usable text → no sidecar
  | "spreadsheet" // XLSX / XLS / CSV → exceljs markdown tables (context only)
  | "text" // plain text / markdown / JSON → decoded inline, not cached
  | "legacy-import" // imported from a pre-refonte session-prefix sidecar
  | "unsupported";

/**
 * Per-call inputs. The service is storage-agnostic: callers inject how
 * to fetch the bytes (for in-process parsing / hashing) and a presigned
 * URL (for Mistral OCR, which fetches the file itself). `onOcr` lets a
 * caller in `@fretik/ai` pass the *traced* `runMistralOcr` so cost lands
 * on Langfuse; it defaults to the raw shared client.
 */
export interface ExtractFileInput {
  organizationId: string;
  fileHash: string;
  mimeType: string;
  filename: string;
  /**
   * Byte size of the original file when the caller knows it (chat
   * attachments, Drive documents, context files all do). Used as a
   * defensive guard against the Mistral OCR file-size limit BEFORE
   * paying for a doomed call — today every Fretik upload cap is below
   * it, so this only fires if upload caps are raised past Mistral's.
   */
  fileSizeBytes?: number;
  /** Raw bytes — used by spreadsheet / text routes and as a fallback. */
  getBytes: () => Promise<Uint8Array>;
  /** Presigned S3 URL reachable from Mistral's servers (OCR routes). */
  getPresignedUrl: () => Promise<string>;
  /**
   * Injectable OCR runner (default: raw `runMistralOcr`). Callers in
   * `@fretik/ai` pass the traced wrapper wrapped in `withTraceSession` /
   * `withPipelineTrace` to keep cost attribution.
   */
  onOcr?: (args: RunOcrArgs) => Promise<OcrResult>;
  /**
   * Optional back-compat hook: returns the markdown of a pre-refonte
   * sidecar already sitting in a legacy location (e.g. the chatbot
   * session prefix) so we import it instead of paying for a re-OCR.
   * Returns `null` when no legacy sidecar exists.
   */
  legacySidecarLookup?: () => Promise<string | null>;
}

/**
 * Normalised extraction result. `markdown` is `null` only for
 * `image-skip` / `unsupported`. `pages` is populated for OCR routes —
 * the exact pages from live OCR on a cache miss, or reconstructed from
 * the flattened sidecar via `splitFlattenedMarkdown` on a cache hit — so
 * the Drive pre-extract pipeline keeps its per-page down-selection; it
 * is `[]` for non-OCR routes.
 */
export interface ExtractionResult {
  route: ExtractionRoute;
  markdown: string | null;
  pages: OcrPage[];
  pageCount: number | null;
  charCount: number | null;
  /** Content-addressed S3 key of the markdown sidecar, or `null`. */
  sidecarS3Key: string | null;
  /**
   * Ids of the stored embedded images (`img-N.ext`), living at
   * `file-extractions/{org}/{hash}/{id}`. `[]` for routes without
   * images and for legacy cache rows extracted before image support.
   */
  imageIds: string[];
  /** Set when extraction failed (the caller turns this into its own error). */
  error?: string;
}
