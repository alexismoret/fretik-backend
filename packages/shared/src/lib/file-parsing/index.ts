/**
 * Stateless file → markdown parsing utility.
 *
 * NOT to be confused with `@fretik/ai`'s `pre-extract` pipeline (OCR
 * + LLM classification + entity extraction with per-page
 * down-selection).
 *
 * Entry point: `parseFileToMarkdown`.
 * Consumers today: `services/ai-context/upload.ts`.
 * Other features needing "bytes + MIME → markdown text" should adopt
 * this module rather than duplicating OCR / spreadsheet logic.
 */
export { SUPPORTED_PARSING_MIMES, parseFileToMarkdown } from "./route";
export {
  DEFAULT_MAX_CHARS,
  FileParsingError,
  type FileParsingErrorCode,
  type ParseFileArgs,
  type ParsedFile,
} from "./types";
