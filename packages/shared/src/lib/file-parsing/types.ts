/**
 * Public types for the file-parsing utility.
 *
 * This module is a **stateless** file-to-markdown converter:
 *
 *   raw bytes + MIME → markdown text
 *
 * It is deliberately decoupled from the documents `pre-extract`
 * pipeline (OCR + LLM classification + entity extraction with
 * per-page down-selection).
 *
 * Callers that just need "give me markdown text for this file" should
 * use `parseFileToMarkdown`. Today the chatbot-context feature
 * (`services/ai-context/upload.ts`) is the primary consumer. The API
 * is kept generic so any future feature needing the same shape can
 * adopt it without adding a second parallel implementation.
 */

export interface ParseFileArgs {
  /** Raw bytes of the file. */
  bytes: Uint8Array;
  /** MIME type — drives the routing decision. */
  mimeType: string;
  /** Original filename — used in diagnostics and for CSV detection. */
  filename: string;
  /**
   * Presigned S3 URL reachable from Mistral's servers. Required for
   * the OCR branch (PDF, DOCX, PPTX, images); ignored for the
   * spreadsheet / text branches that operate on bytes directly.
   */
  presignedUrl?: string;
  /**
   * Per-file character cap. Defaults to 500_000 — comfortably fits a
   * typical rate grid or contract. Larger outputs are truncated with
   * a trailing marker so the caller (and the model) know content was
   * omitted. Set to `Infinity` to disable capping.
   */
  maxChars?: number;
}

export interface ParsedFile {
  /** Extracted content, already capped to `maxChars`. */
  content: string;
  /**
   * Page count for OCR'd documents; worksheet count for spreadsheets;
   * `undefined` for text / markdown / JSON.
   */
  pageCount?: number;
  /** Char count of the FULL extraction before the cap was applied. */
  charCountFull: number;
  /** True when `content` was truncated to respect `maxChars`. */
  truncated: boolean;
  /** Non-fatal notes emitted during parsing (e.g. sheet truncation). */
  warnings: string[];
}

export type FileParsingErrorCode =
  | "unsupported_mime"
  | "ocr_missing_url"
  | "ocr_failed"
  | "spreadsheet_parse_failed"
  | "text_decode_failed";

/**
 * Thrown when a file cannot be parsed into markdown. Callers turn
 * this into an HTTP 415 (`unsupported_mime`) or 500 depending on
 * the `code`.
 */
export class FileParsingError extends Error {
  readonly code: FileParsingErrorCode;
  constructor(code: FileParsingErrorCode, message: string) {
    super(message);
    this.name = "FileParsingError";
    this.code = code;
  }
}

export const DEFAULT_MAX_CHARS = 500_000;
