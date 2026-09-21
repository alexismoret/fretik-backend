import {
  buildPersistedOutputEnvelope,
  PREVIEW_SIZE_CHARS,
} from "@fretik/shared/lib/persisted-output-envelope";
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
 *   - **Domain tools (16K)** — `listDocuments`, `listRecords`, … Tighter
 *     cap nudges the agent to paginate / refine filters instead of
 *     digesting a 100-row JSON dump inline.
 *   - **A collection's schema (48K)** — `describeCollection` returns a
 *     bounded thing (at most `MAX_FIELDS_PER_TYPE` field descriptions,
 *     ~350 chars each), and it is the call the agent makes precisely so
 *     that it can name field keys correctly. Persisting it would answer
 *     "what are this type's fields?" with a file path and cost a `read`
 *     to get back to where it started. The cap tracks the field cap:
 *     it was raised with it, from 30 fields to 100.
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

/**
 * A collection's schema — see file header rationale. Sized from the field cap
 * (100 fields × ~350 chars of key/type/description/writeFormat, plus options),
 * so the widest legal collection still arrives inline.
 */
export const SCHEMA_THRESHOLD_CHARS = 48_000;

/**
 * Characters of the full payload included in the preview block. Re-exported
 * from `@fretik/shared` because the operator repair that fences rows already
 * written has to produce the byte-identical envelope.
 */
export { PREVIEW_SIZE_CHARS };

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
 * Write ONE field of a persisted result to its own file, verbatim.
 *
 * A persisted object is stored as `JSON.stringify(…, null, 2)`, so a long
 * string field inside it arrives as a single line of `\n` and `\"` escapes.
 * That is readable enough to skim and useless to copy an exact anchor out of
 * — and anchors are how the page and document tools take edits. Watching a
 * real session (2026-08-28), the agent spent most of its failed `bash` and
 * `python` calls building nested `python3 -c "…"` one-liners to un-escape a
 * persisted SFC, while every `read` it made succeeded.
 *
 * Returns the workspace-relative path.
 */
export const persistSidecar = async (
  content: string,
  conversationId: string,
  toolCallId: string,
  extension: string,
): Promise<string> => {
  const relativePath = `${WORKSPACE_DIRS.outputsPersisted}/${sanitizeToolCallId(toolCallId)}.${extension}`;
  await writeFile(conversationId, relativePath, content);
  return relativePath;
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
): string => buildPersistedOutputEnvelope(result);

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
    // Nowhere to persist it, so bound it in place. This used to return the
    // content untouched — "truncating would be worse than a slightly oversized
    // tool turn" — and that reasoning only held while "oversized" meant a fat
    // payload. Measured on production rows, it means a 32.5 MB message: the
    // barrier being OFF is not a smaller version of the barrier being on.
    // Head and tail both, for the same reason the error path keeps both.
    return boundedText(serialized, threshold);
  }

  const result = await persistToolResult(content, conversationId, toolCallId);
  return buildPersistedOutputMessage(result);
};

/**
 * Budget for ONE stream field (`stdout` / `stderr`) inside a tool's ERROR
 * envelope.
 *
 * Two of them plus the error line keeps a failed call at roughly what a
 * successful one costs (`DEFAULT_THRESHOLD_CHARS`), which is the invariant
 * that was missing: on 2026-09-17 the 17 largest production messages carried
 * 6.4 MB of `tool-python` and 1.5 MB of `tool-bash`, none of it
 * microcompactable — and both tools reached `maybePersistLargeOutput` only on
 * their SUCCESS path. An error returned whatever the sandbox printed.
 */
export const ERROR_STREAM_BUDGET_CHARS = 12_000;

/** Head and tail kept when a text field is cut. */
export const boundedText = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  // Half and half. A Python traceback puts the exception on its LAST line
  // (most recent call last) and the entry point on its first, so a head-only
  // cut throws away the one line the model needs; a shell command that failed
  // after a long run is the same shape. Keeping both ends is cheap and the
  // middle of a 6 MB dump is where the least information is.
  const half = Math.floor(budget / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n[… ${dropped.toLocaleString()} characters dropped …]\n\n${text.slice(-half)}`;
};

/**
 * Bound a tool ERROR's stream field, persisting the full text when there is a
 * conversation to persist it to.
 *
 * Deliberately NOT `maybePersistLargeOutput`: that one replaces the whole
 * value with a `<persisted-output>` string, and an error envelope's SHAPE is
 * load-bearing — `{ error, code, stdout, stderr, hint? }` is what the model
 * reads, what `lib/tool-error-codes.ts` documents and what the frontend
 * renders. So the fields are bounded, the envelope is not.
 *
 * Never throws: a failure to persist must degrade to a truncated field, not
 * turn a tool error into a tool crash.
 */
export const boundErrorStream = async (
  text: string,
  conversationId: string | undefined,
  toolCallId: string,
  label: string,
  budget: number = ERROR_STREAM_BUDGET_CHARS,
): Promise<string> => {
  if (text.length <= budget) return text;
  const bounded = boundedText(text, budget);
  if (!conversationId) return bounded;
  try {
    const path = await persistSidecar(
      text,
      conversationId,
      `${toolCallId}-${label}`,
      "txt",
    );
    return `${bounded}\n\n[full ${label} saved to ${path} — read() it for the part that was cut]`;
  } catch {
    return bounded;
  }
};
