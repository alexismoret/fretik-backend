import {
  isImageMime,
  isOcrDocumentMime,
  isSpreadsheetMime,
  isTextMime,
} from "../../utils/mimeTypes";
import type { ExtractionRoute } from "./types";

/**
 * MIME → extraction-route dispatcher. The MIME passed here is the REAL
 * type already resolved from magic bytes at the upload boundary
 * (`detectMimeFromBytes`), so routing trusts it directly — no extension
 * guessing. All category logic delegates to the canonical predicates in
 * `utils/mimeTypes` so the lists live in exactly one place.
 *
 *  - PDF / DOCX / DOC / PPTX / PPT → `mistral-ocr` (native, reads
 *    embedded-image text; PDFs keep table fidelity).
 *  - images → `image-ocr` (caller downgrades to `image-skip` when OCR
 *    yields no usable text).
 *  - XLSX / XLS / CSV → `spreadsheet` (exceljs; context only — the
 *    chatbot routes spreadsheets to `python` instead).
 *  - any UTF-8 text/code/data → `text` (decoded inline, not cached).
 *  - genuinely-binary unknown → `unsupported`.
 */
export const routeForMime = (mimeType: string): ExtractionRoute => {
  if (isOcrDocumentMime(mimeType)) return "mistral-ocr";
  if (isImageMime(mimeType)) return "image-ocr";
  if (isSpreadsheetMime(mimeType)) return "spreadsheet";
  if (isTextMime(mimeType)) return "text";
  return "unsupported";
};

/** Routes whose result is worth persisting in the content-addressed cache. */
export const isCacheableRoute = (route: ExtractionRoute): boolean =>
  route === "mistral-ocr" ||
  route === "image-ocr" ||
  route === "spreadsheet" ||
  route === "legacy-import";
