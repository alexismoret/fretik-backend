/**
 * The `<persisted-output>` envelope, and only the envelope.
 *
 * It lives here rather than beside the tool machinery in `@fretik/ai` because
 * two very different writers must produce the byte-identical shape: the tools,
 * which fence an output as it is produced, and the operator repair that fences
 * rows already written. A model that learned to reopen one and not the other
 * would be reading two formats for one idea.
 *
 * Everything else about persistence — thresholds, where the file goes, when to
 * fence — stays in `@fretik/ai/lib/persisted-output`.
 */

/** Characters of the full payload included in the preview block. */
export const PREVIEW_SIZE_CHARS = 2_000;

const OPEN_TAG = "<persisted-output>";
const CLOSE_TAG = "</persisted-output>";

export interface PersistedOutputEnvelope {
  /** Path relative to `/workspace`, e.g. `outputs/persisted/abc.txt`. */
  path: string;
  /** Byte length of the saved payload on disk. */
  sizeBytes: number;
  /** Total character length of the serialized payload. */
  totalChars: number;
  /** First `PREVIEW_SIZE_CHARS` characters of the payload. */
  preview: string;
}

/**
 * Size + path + preview, the shape Claude Code's
 * `buildLargeToolResultMessage` uses. The path is workspace-relative so the
 * model can hand it straight to `read(path)` or `python(...)` without
 * translating an absolute path, and the envelope names no tool — the model
 * picks from its own catalogue.
 */
export const buildPersistedOutputEnvelope = (
  result: PersistedOutputEnvelope,
): string => {
  const sizeKb = (result.sizeBytes / 1024).toFixed(1);
  return [
    OPEN_TAG,
    `Output too large (${sizeKb} KB, ${result.totalChars.toLocaleString()} chars). Full output saved to: ${result.path}`,
    "",
    `Preview (first ${PREVIEW_SIZE_CHARS.toLocaleString()} chars):`,
    result.preview,
    "...",
    CLOSE_TAG,
  ].join("\n");
};
