import type { UIMessageChunk } from "ai";
// node:stream/web's TransformStream, not the DOM global — same reason as
// lib/scrub-stream.ts (DOM's ReadableStream iterator carries
// `[Symbol.asyncDispose]`, which TS cannot unify with the AI SDK's).
import { TransformStream } from "node:stream/web";

import { NON_TERMINAL_WIRE_ERRORS } from "./stream-errors";

/**
 * Strip the `error` frames that do not mean "this turn is dead".
 *
 * An `error` chunk is not a free annotation on the wire. Since ai@7.0.85
 * the client's `Chat` consumes the stream through
 * `processUIMessageStream({ onError: (e) => { throw e } })`, so ANY error
 * chunk throws inside the transform, rejects `consumeStream`, and lands in
 * the catch that sets `status: "error"`. The client stops reading the turn
 * right there — whatever the frame said.
 *
 * That turned three deliberately harmless frames into failures:
 *
 *   - `FAILOVER_SENTINEL` — the client ignores the text, so it showed no
 *     error at all; it just stopped consuming, and the fallback model's
 *     answer streamed into a socket nobody was reading. The turn froze
 *     with no indication whatsoever.
 *   - `TOOL_INPUT_RETRY_NOTICE` — a red alert carrying that raw English
 *     sentence, while the model self-corrected and the turn carried on.
 *   - `NON_TERMINAL_STEP_ERROR` — a provider step failure the agent loop
 *     absorbs (NextBit 502, prod 2026-09-08: errored at step 2, answered
 *     at step 8 three minutes later).
 *
 * Dropping them at the wire is what makes them non-events for every
 * consumer at once: the initiating POST, a resumed GET, and every
 * collaborative viewer all read the same turn log, which is fed from this
 * stream. The recorder branch is upstream of here and ignores errors on
 * its own (`terminateOnError: false`), and Langfuse keeps its WARNING
 * event either way — nothing observable is lost.
 *
 * A genuinely dead turn still gets its structured JSON frame, written
 * after the merge by the branch that knows the turn died.
 */
export const dropNonTerminalErrorFrames = () =>
  new TransformStream({
    transform(chunk: UIMessageChunk, controller) {
      if (
        chunk.type === "error" &&
        NON_TERMINAL_WIRE_ERRORS.has(chunk.errorText)
      ) {
        return;
      }
      controller.enqueue(chunk);
    },
  });
