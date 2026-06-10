import { fileTypeFromBuffer } from "file-type";

// ============================================================================ //
// CANONICAL MIME CATEGORIES (single source of truth)                          //
// ----------------------------------------------------------------------------//
// Every surface (shared / api / ai) routes files through these sets + the     //
// predicates below instead of re-declaring MIME lists. Detection of the REAL  //
// type is done once from magic bytes (`detectMimeFromBytes`) at each upload    //
// boundary, then the stored MIME is trusted everywhere downstream — never the //
// filename extension (often malformed) nor the browser-provided `file.type`.  //
// ============================================================================ //

/** PDF + Office documents — extracted via Mistral OCR (native, reads embedded-image text). */
export const OCR_DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint", // .ppt
]);

/** Raster images — OCR'd for text, else handed to the vision tool. */
export const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

/** Spreadsheets — exceljs markdown tables (context only); chatbot routes to python. */
export const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "text/csv",
]);

/**
 * Non-`text/*` MIMEs that are nonetheless UTF-8 source/data. The long
 * tail of code files is caught by the magic-byte miss + UTF-8 sniff in
 * `detectMimeFromBytes`, NOT by an extension list.
 */
export const TEXT_APPLICATION_MIMES: ReadonlySet<string> = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/sql",
  "application/graphql",
  "application/toml",
]);

/**
 * Canonical, IANA-registered text MIMEs we are willing to PERSIST as a
 * file's stored type. `detectMimeFromBytes` normalises any other
 * UTF-8-text input to `text/plain` so we never store a vendor / legacy /
 * bogus type (`text/x-python`, `application/x-yaml`, `text/foobar`, …) —
 * routing stays lenient via `isTextMime`, but the stored value is always
 * a real type. `application/json` is kept distinct because the parser
 * pretty-prints it.
 */
export const CANONICAL_TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/css",
  "text/csv",
  "text/javascript",
  "text/xml",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/yaml",
]);

/** Strip MIME parameters: `text/csv;charset=utf-8` → `text/csv`. */
export const baseMime = (mimeType: string): string =>
  mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

export const isOcrDocumentMime = (mimeType: string): boolean =>
  OCR_DOCUMENT_MIMES.has(baseMime(mimeType));

export const isImageMime = (mimeType: string): boolean =>
  baseMime(mimeType).startsWith("image/");

export const isSpreadsheetMime = (mimeType: string): boolean => {
  const base = baseMime(mimeType);
  return (
    SPREADSHEET_MIMES.has(base) ||
    base.includes("csv") ||
    base.includes("excel") ||
    base.includes("spreadsheet")
  );
};

/** Any UTF-8-readable text/code/data file (prose, JSON, XML, source code). */
export const isTextMime = (mimeType: string): boolean => {
  const base = baseMime(mimeType);
  return base.startsWith("text/") || TEXT_APPLICATION_MIMES.has(base);
};

/**
 * Heuristic: are these bytes UTF-8 text (vs binary)? A NUL byte in the
 * head is a reliable binary tell; otherwise we decode and reject only
 * when replacement chars dominate. Used to distinguish source-code /
 * plain-text uploads (which `file-type` cannot detect) from unknown
 * binaries.
 */
export const isLikelyUtf8Text = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0) return true;
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false; // NUL → binary
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let bad = 0;
  for (const ch of text) if (ch === "�") bad += 1;
  return bad / text.length < 0.01;
};

/**
 * Resolve the REAL MIME of a file from its magic bytes, falling back to
 * a UTF-8 text sniff. This is the canonical detection used at every
 * upload boundary so downstream routing never trusts the extension or
 * the browser-supplied type.
 *
 *  1. `file-type` magic-byte detection → authoritative for binaries
 *     (PDF, DOCX/XLSX/PPTX, images, …).
 *  2. No magic signature → it is not a known binary. If the bytes are
 *     UTF-8 text, NORMALISE to a canonical registered text MIME: keep
 *     the declared type only when it's in `CANONICAL_TEXT_MIMES`,
 *     otherwise `text/plain`. This stores a real type for every text /
 *     code file and IGNORES a wrong binary `declaredMime` (the "a .txt
 *     named .pdf" case).
 *  3. Otherwise fall back to the declared MIME, or `application/octet-stream`.
 */
export const detectMimeFromBytes = async (
  bytes: Uint8Array,
  declaredMime?: string,
): Promise<string> => {
  const detected = await fileTypeFromBuffer(bytes);
  if (detected?.mime) return detected.mime;
  if (isLikelyUtf8Text(bytes)) {
    return CANONICAL_TEXT_MIMES.has(baseMime(declaredMime ?? ""))
      ? baseMime(declaredMime ?? "")
      : "text/plain";
  }
  const fallback = declaredMime?.trim();
  return fallback && fallback !== "application/octet-stream"
    ? fallback
    : "application/octet-stream";
};

// ==================== //
// ALLOWED TYPES        //
// ==================== //

export const ALLOWED_MIME_TYPES: string[] = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
];

export const ALLOWED_EXTENSIONS: string[] = [
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".csv",
  ".pptx",
  ".ppt",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];

// ==================== //
// DETECTION HELPERS    //
// ==================== //

export const isPdf = (mimeType: string): boolean =>
  mimeType.includes("application/pdf");

export const isImage = (mimeType: string): boolean =>
  mimeType.startsWith("image/");

/**
 * Spreadsheets (Excel / CSV) — uses includes() to handle
 * variants like "text/csv;charset=utf-8"
 */
export const isSpreadsheet = (mimeType: string): boolean =>
  mimeType.includes("csv") ||
  mimeType.includes("excel") ||
  mimeType.includes("spreadsheet");

export const isConversionRequired = (mimeType: string): boolean =>
  !isPdf(mimeType);

/**
 * True when a file's MIME is accepted by the Drive document pipeline
 * (`uploadDocument` → `assertFile`). Checks the (magic-byte detected)
 * MIME only — that's the reliable signal; a wrong extension on an
 * otherwise-supported file shouldn't bar it.
 *
 * The chatbot attachment set (`isChatbotSupported`) is a SUPERSET —
 * markdown / JSON / XML / arbitrary `text/*` are fine as chat
 * attachments but the Drive rejects them. Callers promoting a chat file
 * to the Drive must pre-check with this so the rejection is surfaced
 * explicitly instead of throwing a generic 400 deep in the pipeline.
 */
export const isDriveSupported = (mimeType: string): boolean => {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_MIME_TYPES.includes(base);
};

// ==================== //
// CHATBOT ATTACHMENTS  //
// ==================== //

/**
 * MIME types accepted by the chatbot file attachment flow (Phase 11).
 * Superset of `ALLOWED_MIME_TYPES` (Drive documents) plus a handful of
 * lightweight text formats that are useful as chat attachments but not
 * worth running through the full Drive pre-extraction pipeline.
 *
 * Kept in sync with `app/app/utils/mimeTypes.ts` on the frontend — the
 * frontend reads this list directly via the `@fretik/shared` workspace
 * import. See `chatbot-overhaul-plan.md` Phase 11 decision 11.
 */
export const CHATBOT_ACCEPTED_MIMES: readonly string[] = [
  // Documents — same set the Drive pipeline accepts.
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  // Images — OCR'd via Mistral when the sidecar content is exploitable.
  "image/png",
  "image/jpeg",
  "image/webp",
  // Plain-text / lightweight data formats — passthrough, no preprocessing.
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
] as const;

export const isChatbotSupported = (mimeType: string): boolean => {
  // Strip any parameter (e.g. "text/csv;charset=utf-8").
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  // Documents / images / spreadsheets from the explicit list, PLUS any
  // UTF-8-readable text/code/data file (source code arrives under a wide
  // range of `text/*` MIMEs the agent can usefully `read`).
  return CHATBOT_ACCEPTED_MIMES.includes(base) || isTextMime(base);
};

/**
 * True when the MIME type requires Mistral OCR to become readable text
 * (PDF / office docs / images). Now resolved via the canonical category
 * predicates. NOTE: extraction is lazy (first `read`) + cached, not run
 * at upload — see `services/file-extraction`.
 */
export const requiresOcrPreprocessing = (mimeType: string): boolean =>
  isOcrDocumentMime(mimeType) || isImageMime(mimeType);
