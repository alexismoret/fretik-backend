import { WORKSPACE_DIRS, writeFile } from "./conversation-storage";

/**
 * Filesystem-backed large output storage for tool results, inspired by
 * Claude Code's `toolResultStorage.ts`.
 *
 * When a tool returns more than `DEFAULT_THRESHOLD_CHARS` characters,
 * we save the full JSON (or text) payload via the conversation
 * storage façade at
 *
 *     /workspace/outputs/persisted/{toolCallId}.(json|txt)
 *
 * and hand the model back a `<persisted-output>` envelope containing a
 * short preview plus the workspace-relative path. From there the model
 * can quote the preview, re-read the full file via `read`, or process
 * it programmatically via `python`. The envelope deliberately does
 * not name a tool — the model picks from the catalogue, matching
 * Claude Code's minimal `buildLargeToolResultMessage` shape.
 *
 * Threshold model: a **single default** at 32K covers nearly every
 * tool. Two documented exceptions keep their custom cap:
 *
 *   - **RAG (48K)** — RAG is the model's primary content-fetching
 *     tool. Tripping persistence forces a follow-up `read` call (one
 *     wasted turn). 48K keeps the typical top-20 chunk result inline
 *     while still capping pathological cases.
 *   - **Domain tools (16K)** — `listDocuments`, `listRecords`,
 *     `describeCollection`, … Tighter cap nudges the agent
 *     to paginate / refine
 *     filters instead of digesting a 100-row JSON dump inline.
 *
 * Everything else uses the default. New tools should NOT add custom
 * thresholds without strong justification — every magic number costs
 * cognitive load on the agent and on future readers.
 */

/** Single-valued default cap for tool results that don't override. */
export const DEFAULT_THRESHOLD_CHARS = 32_000;

/** Domain-tool tighter cap — see file header rationale. */
export const DOMAIN_TOOL_THRESHOLD_CHARS = 16_000;

/** RAG higher cap — see file header rationale. */
export const RAG_THRESHOLD_CHARS = 48_000;

/** Characters of the full payload included in the preview block. */
export const PREVIEW_SIZE_CHARS = 2_000;

const PERSISTED_OUTPUT_OPEN_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSE_TAG = "</persisted-output>";

export interface PersistedToolResult {
  /** Path relative to `/workspace`, e.g. `outputs/persisted/abc.txt`. */
  path: string;
  /** Absolute sandbox path, e.g. `/workspace/outputs/persisted/abc.txt`. */
  absolutePath: string;
  /** Byte length of the saved payload on disk. */
  sizeBytes: number;
  /** First `PREVIEW_SIZE_CHARS` characters of the payload. */
  preview: string;
  /** Total character length of the serialized payload. */
  totalChars: number;
  /** True when the original content was a structured object (JSON). */
  isJson: boolean;
}

/**
 * Restrict tool-call ids to a safe filesystem character set. UUIDs,
 * nanoids, and AI SDK tool call ids all survive untouched.
 */
const sanitizeToolCallId = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

const buildOutputRelativePath = (toolCallId: string, isJson: boolean): string =>
  `${WORKSPACE_DIRS.outputsPersisted}/${sanitizeToolCallId(toolCallId)}.${
    isJson ? "json" : "txt"
  }`;

/**
 * Write a tool result to the conversation's `/workspace/outputs/persisted/`
 * directory and return the metadata the model needs to reference it.
 * Callers should prefer `maybePersistLargeOutput`, which only persists
 * when the serialized payload crosses the threshold; this function is
 * exported for the rare case where a tool already knows its output is
 * too large to keep in memory.
 */
export const persistToolResult = async (
  content: unknown,
  conversationId: string,
  toolCallId: string,
): Promise<PersistedToolResult> => {
  const isJson = typeof content !== "string";
  const serialized = isJson ? JSON.stringify(content, null, 2) : content;

  const relativePath = buildOutputRelativePath(toolCallId, isJson);
  await writeFile(conversationId, relativePath, serialized);

  const totalChars = serialized.length;
  const preview = serialized.slice(0, PREVIEW_SIZE_CHARS);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  return {
    path: relativePath,
    absolutePath: `/workspace/${relativePath}`,
    sizeBytes,
    preview,
    totalChars,
    isJson,
  };
};

/**
 * Build the `<persisted-output>` envelope the model sees in place of
 * the full tool result. Same shape as Claude Code's
 * `buildLargeToolResultMessage`: size + path + preview. The path is
 * workspace-relative so the model can hand it straight back to
 * `read(path)` or `python(...)` without translating absolute paths.
 */
export const buildPersistedOutputMessage = (
  result: PersistedToolResult,
): string => {
  const sizeKb = (result.sizeBytes / 1024).toFixed(1);
  return [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${sizeKb} KB, ${result.totalChars.toLocaleString()} chars). Full output saved to: ${result.path}`,
    "",
    `Preview (first ${PREVIEW_SIZE_CHARS.toLocaleString()} chars):`,
    result.preview,
    "...",
    PERSISTED_OUTPUT_CLOSE_TAG,
  ].join("\n");
};

/**
 * Swap `content` for a `<persisted-output>` string only if the
 * serialized payload is larger than the threshold. Otherwise the
 * content is returned untouched so the model sees the full structured
 * object as usual.
 *
 * Most tools should call this with three arguments and inherit
 * `DEFAULT_THRESHOLD_CHARS`. The two documented exceptions
 * (`RAG_THRESHOLD_CHARS` for `searchKnowledge`,
 * `DOMAIN_TOOL_THRESHOLD_CHARS` for `listDocuments` /
 * `listRecords` / etc.) pass an
 * explicit `threshold`. New tools should NOT introduce new custom
 * thresholds without justification.
 *
 * When no `conversationId` is available (e.g. a stateless internal
 * invocation with no persisted conversation), we return the raw
 * content unchanged — truncating would be worse than a slightly
 * oversized tool turn, and the model can still handle the occasional
 * fat payload. Matches Claude Code's `shouldPersistLargeToolResult`
 * fallback.
 */
export const maybePersistLargeOutput = async <T>(
  content: T,
  conversationId: string | undefined,
  toolCallId: string,
  threshold: number = DEFAULT_THRESHOLD_CHARS,
): Promise<T | string> => {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  if (serialized.length <= threshold) {
    return content;
  }
  if (!conversationId) {
    return content;
  }

  const result = await persistToolResult(content, conversationId, toolCallId);
  return buildPersistedOutputMessage(result);
};
