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
  return CHATBOT_ACCEPTED_MIMES.includes(base);
};

/**
 * True when the MIME type requires Mistral OCR preprocessing before
 * the chatbot can read it. PDFs and office docs always go through
 * OCR; images go through conditionally (heuristic: keep sidecar only
 * if extracted text is non-trivial).
 */
export const requiresOcrPreprocessing = (mimeType: string): boolean => {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base === "application/pdf" ||
    base ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    base === "application/msword" ||
    base ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    base === "application/vnd.ms-powerpoint" ||
    base.startsWith("image/")
  );
};
