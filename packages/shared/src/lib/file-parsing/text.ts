import { FileParsingError } from "./types";

/**
 * Text / markdown / JSON branch. Decodes raw bytes as UTF-8, strips
 * the BOM, and pretty-prints JSON inside a fenced code block so the
 * structure survives the injection into a larger markdown document.
 */

const TEXT_LIKE_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
]);

const JSON_MIME = "application/json";

export const isTextLikeMime = (mimeType: string): boolean =>
  TEXT_LIKE_MIMES.has(mimeType) || mimeType === JSON_MIME;

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

export const parseAsText = (args: {
  bytes: Uint8Array;
  mimeType: string;
}): string => {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: false }).decode(args.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FileParsingError(
      "text_decode_failed",
      `Failed to decode file as UTF-8: ${message}`,
    );
  }
  const clean = stripBom(decoded);
  if (args.mimeType === JSON_MIME) {
    // Pretty-print when valid; fall back to raw text otherwise so a
    // malformed JSON file never blocks ingestion.
    try {
      const parsed: unknown = JSON.parse(clean);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      return "```json\n" + clean + "\n```";
    }
  }
  return clean;
};
