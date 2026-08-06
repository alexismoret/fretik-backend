import type { UIMessageChunk } from "ai";
// Use node:stream/web's TransformStream rather than the DOM global:
// Bun implements both, but the DOM lib's TransformStream clashes with
// `AsyncIterableStream.pipeThrough` typings (DOM's ReadableStream has
// `[Symbol.asyncDispose]` on its iterator, web-streams doesn't — TS
// can't unify them). Using the node:stream/web types keeps the
// standard Bun runtime semantics (same native implementation, zero
// overhead) while matching the iterator shape the AI SDK expects.
import { TransformStream } from "node:stream/web";

/**
 * Tool names whose `input` is considered sensitive and must never
 * leave the backend verbatim on the streamed UI channel. The model
 * still sees the real input (it produced it and needs it to reason
 * on subsequent turns), and the DB-persisted assistant message keeps
 * the real input too — only the bytes sent to the browser are
 * scrubbed.
 *
 * The transform lives in front of the wire (chat turn-log pump and
 * workflow transcript pump alike) so onFinish / persistence receive
 * the unmodified frame set, which matters for model replay on the
 * next turn.
 */
const SENSITIVE_TOOL_NAMES = new Set(["querySql"]);

/**
 * Keys stripped from a sensitive tool's `tool-input-available` chunk.
 * Keep the envelope (toolCallId, toolName, state) so the client still
 * renders the spinner and runs the tool lifecycle; just empty out the
 * payload fields that carry the secret.
 */
const SENSITIVE_INPUT_KEYS_TO_REDACT = new Set(["sql_query"]);

/**
 * Filter the outbound UI stream so sensitive tool inputs never reach
 * the client. Rewrites these chunk types:
 *
 *   - `tool-input-start` → pass through, but remember the toolCallId
 *     so we can scrub its downstream deltas/available events.
 *   - `tool-input-delta` → drop deltas for sensitive tools (they
 *     stream the raw JSON of the tool call args; replaying them
 *     client-side would defeat the scrub).
 *   - `tool-input-available` → keep the envelope, scrub the listed
 *     fields on its `input` object.
 *
 * Every other chunk type passes through untouched. Back-pressure is
 * preserved because we enqueue 0 or 1 chunks per incoming chunk.
 */
export const buildSensitiveInputScrubber = () => {
  const sensitiveCallIds = new Set<string>();
  return new TransformStream({
    transform(chunk: UIMessageChunk, controller) {
      if (chunk.type === "tool-input-start") {
        if (SENSITIVE_TOOL_NAMES.has(chunk.toolName)) {
          sensitiveCallIds.add(chunk.toolCallId);
        }
        controller.enqueue(chunk);
        return;
      }
      if (
        chunk.type === "tool-input-delta" &&
        sensitiveCallIds.has(chunk.toolCallId)
      ) {
        // Swallow — the client will jump from input-streaming to
        // input-available without seeing any body fragment.
        return;
      }
      if (
        chunk.type === "tool-input-available" &&
        sensitiveCallIds.has(chunk.toolCallId)
      ) {
        const input = chunk.input;
        if (input && typeof input === "object") {
          const scrubbed: Record<string, unknown> = {};
          const inputRecord: Record<string, unknown> = { ...input };
          for (const key of Object.keys(inputRecord)) {
            scrubbed[key] = SENSITIVE_INPUT_KEYS_TO_REDACT.has(key)
              ? undefined
              : inputRecord[key];
          }
          controller.enqueue({ ...chunk, input: scrubbed });
        } else {
          controller.enqueue(chunk);
        }
        return;
      }
      controller.enqueue(chunk);
    },
  });
};
