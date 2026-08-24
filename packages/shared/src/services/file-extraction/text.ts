/**
 * Text branch of the extraction pipeline. Decodes raw bytes as UTF-8,
 * strips the BOM, and pretty-prints JSON inside a fenced code block so
 * the structure survives injection into a larger markdown document.
 *
 * Every textual format lands here — prose, markdown, source code,
 * configuration — because for all of them the bytes ARE the content.
 */

const JSON_MIME = "application/json";

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

export const parseAsText = (args: {
  bytes: Uint8Array;
  mimeType: string;
}): string => {
  const clean = stripBom(
    new TextDecoder("utf-8", { fatal: false }).decode(args.bytes),
  );
  if (args.mimeType !== JSON_MIME) return clean;
  // Pretty-print when valid; fall back to raw text otherwise so a
  // malformed JSON file never blocks ingestion.
  try {
    const parsed: unknown = JSON.parse(clean);
    return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
  } catch {
    return "```json\n" + clean + "\n```";
  }
};
