import { parseViaOcr } from "./ocr";
import { parseSpreadsheet } from "./spreadsheet";
import { isTextLikeMime, parseAsText } from "./text";
import {
  DEFAULT_MAX_CHARS,
  FileParsingError,
  type ParseFileArgs,
  type ParsedFile,
} from "./types";

/**
 * MIME → parsing-branch dispatcher. Three branches cover the whole
 * surface of files the chatbot can make sense of today:
 *
 *  - OCR branch: PDF, Word (DOCX), PowerPoint (PPTX), images (PNG,
 *    JPEG, WebP). Mistral OCR handles all of these natively — no
 *    Gotenberg conversion step.
 *
 *  - Spreadsheet branch: XLSX / XLS / CSV. Parsed in-process with
 *    exceljs into one markdown table per worksheet. Aligned with
 *    Anthropic's guidance of embedding spreadsheet content as text
 *    when it must be available without a code-execution tool.
 *
 *  - Text branch: plain text / markdown / JSON. Decoded as UTF-8,
 *    BOM stripped, JSON pretty-printed inside a fenced block.
 *
 * Any other MIME throws `FileParsingError` with code `unsupported_mime`
 * so the API layer can surface a clean 415.
 */

const OCR_DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-powerpoint",
]);

const OCR_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]);

/**
 * Full list of MIME types the parser accepts. Callers that need to
 * validate an upload early should reuse this set rather than
 * hard-coding their own list.
 */
export const SUPPORTED_PARSING_MIMES: readonly string[] = [
  ...OCR_DOCUMENT_MIMES,
  ...OCR_IMAGE_MIMES,
  ...SPREADSHEET_MIMES,
  "text/plain",
  "text/markdown",
  "application/json",
];

const isOcrMime = (mimeType: string): boolean =>
  OCR_DOCUMENT_MIMES.has(mimeType) || OCR_IMAGE_MIMES.has(mimeType);

const isSpreadsheetMime = (mimeType: string): boolean =>
  SPREADSHEET_MIMES.has(mimeType);

/**
 * Apply the per-file char cap with a trailing marker. Content up to
 * `maxChars` is preserved verbatim; anything longer is truncated and
 * a `_…truncated…_` footer is appended so downstream consumers can
 * see content was omitted.
 */
const applyCharCap = (
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } => {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  const cut = Math.max(0, maxChars - 80);
  const head = content.slice(0, cut);
  return {
    content: `${head}\n\n_…truncated (${(content.length - cut).toString()} chars omitted)…_`,
    truncated: true,
  };
};

/**
 * Parse a file's raw bytes into markdown text. Stateless — no DB,
 * no S3 writes, no side effects besides the Mistral OCR call when
 * the input requires it.
 */
export const parseFileToMarkdown = async (
  args: ParseFileArgs,
): Promise<ParsedFile> => {
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const warnings: string[] = [];

  let rawContent: string;
  let pageCount: number | undefined;

  if (isOcrMime(args.mimeType)) {
    const ocr = await parseViaOcr({
      presignedUrl: args.presignedUrl,
      mimeType: args.mimeType,
    });
    rawContent = ocr.content;
    pageCount = ocr.pageCount;
  } else if (isSpreadsheetMime(args.mimeType)) {
    const sheet = await parseSpreadsheet({
      bytes: args.bytes,
      mimeType: args.mimeType,
      filename: args.filename,
    });
    rawContent = sheet.content;
    pageCount = sheet.sheetCount;
    warnings.push(...sheet.warnings);
  } else if (isTextLikeMime(args.mimeType)) {
    rawContent = parseAsText({
      bytes: args.bytes,
      mimeType: args.mimeType,
    });
  } else {
    throw new FileParsingError(
      "unsupported_mime",
      `Unsupported MIME type: ${args.mimeType}`,
    );
  }

  const charCountFull = rawContent.length;
  const capped = applyCharCap(rawContent, maxChars);

  return {
    content: capped.content,
    pageCount,
    charCountFull,
    truncated: capped.truncated,
    warnings,
  };
};
