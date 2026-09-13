/**
 * Per-turn stage timings — the instrumentation the pre-turn path never had.
 *
 * Before this, the only signal a turn emitted about everything that happens
 * BEFORE the first token was `activeMemory=hit|miss`. Whether a slow turn was
 * slow because of recall, the context manifest, the attachment listing or the
 * external-app query was unanswerable from production logs, so every latency
 * decision on that path was taken on code reading rather than measurement.
 *
 * The contract is deliberately minimal: a plain mutable record of
 * `label → milliseconds`, filled by `timeStage`, and emitted on two surfaces
 * that answer different questions. `formatTimings` writes ONE key=value line
 * per turn — what you grep during an incident, and what survives a replica
 * restart. `recordTimingsOnTrace` puts the same numbers on the Langfuse trace,
 * where the turn's cost and model latency already live and where a p95 across a
 * day of traffic can actually be computed.
 *
 * Langfuse already covers the LLM calls themselves (each generation is its own
 * costed observation); what it could not see is the SQL / HTTP / cache work
 * around them, which is exactly what these labels name.
 */

import { getActiveSpanId, startObservation } from "@langfuse/tracing";
import { langfuseEnabled } from "./langfuse";

export type StageTimings = Record<string, number>;

/**
 * Measure how long `work` takes to settle and stamp it into `timings`.
 *
 * Takes an already-started promise rather than a thunk on purpose: every
 * caller passes these inside one `Promise.all([...])`, where the array
 * elements are all constructed — and therefore all started — at the same
 * instant. Timing from call-site to settle is then the stage's real
 * wall-clock contribution to the turn, including any queueing behind a
 * saturated connection pool, which a thunk deferred to `await` time would
 * hide.
 *
 * Never changes the outcome: a rejection is stamped and re-thrown, so a stage
 * that soft-fails upstream still reports how long it took to fail.
 */
export const timeStage = async <T>(
  timings: StageTimings,
  label: string,
  work: Promise<T>,
): Promise<T> => {
  const started = Date.now();
  try {
    return await work;
  } finally {
    timings[label] = Date.now() - started;
  }
};

/**
 * Stamp "how long since `startedAt`" under `label`.
 *
 * `timeStage` covers work that is a promise; this covers the rest — a phase
 * whose boundary is a point in time rather than a settle, which is every
 * cumulative TTFT figure (route entry → here) and every stage assembled from
 * several awaits.
 */
export const markSince = (
  timings: StageTimings,
  label: string,
  startedAt: number,
): void => {
  timings[label] = Date.now() - startedAt;
};

/**
 * The chunk types that count as the turn's FIRST BYTE.
 *
 * Not every frame the model stream emits is output: `start`, `start-step` and
 * the metadata frames are bookkeeping the SDK sends as soon as the provider
 * call opens, so tapping "the first chunk" would measure the HTTP handshake
 * and report a TTFT the user never experienced. These three are the first
 * frames that carry something a reader could see — visible text, a reasoning
 * trace, or the tool call that explains the pause before either.
 */
const FIRST_BYTE_CHUNK_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
]);

/**
 * Fire `onFirst` once, when the first output frame reaches the wire.
 *
 * A pass-through transform in the shape of `dropChunksAfterAbort`: the chunk
 * is enqueued BEFORE the callback runs, so instrumentation can never delay the
 * byte it is measuring, and a throwing callback is swallowed — a turn must
 * never die of its own telemetry. Fires at most once per stream; a turn that
 * merges several streams (fallback model, dead-step continuation) passes the
 * same once-guarded callback to each.
 */
const chunkType = (chunk: unknown): string =>
  typeof chunk === "object" &&
  chunk !== null &&
  "type" in chunk &&
  typeof chunk.type === "string"
    ? chunk.type
    : "";

export const tapFirstChunk = <C>(
  stream: ReadableStream<C>,
  onFirst: () => void,
): ReadableStream<C> => {
  let fired = false;
  const reader = stream.getReader();
  // Pull-based rather than a `TransformStream`: backpressure is preserved
  // (one `read` per downstream `pull`) and the ambient `pipeThrough` typing —
  // which disagrees with itself across this package's modules — stays out of
  // it. A source error rejects `pull`, which errors the stream, so failures
  // propagate exactly as they did without the tap.
  return new ReadableStream<C>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      if (fired || !FIRST_BYTE_CHUNK_TYPES.has(chunkType(value))) return;
      fired = true;
      try {
        onFirst();
      } catch {
        // Swallow — see `recordTimingsOnTrace`.
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
};

/**
 * Render `timings` as `label=<ms>` pairs, slowest first — so the head of the
 * line is the stage worth looking at, whatever the turn's shape. Stages run
 * in parallel, so these do NOT sum to the total; `preTurnTotal` is measured
 * separately by the caller and is the number that matters for TTFT.
 */
export const formatTimings = (timings: StageTimings): string =>
  Object.entries(timings)
    .sort(([, a], [, b]) => b - a)
    .map(([label, ms]) => `${label}=${ms.toString()}`)
    .join(" ");

/**
 * Put the same numbers on the trace, as one observation carrying every stage
 * as metadata.
 *
 * A log line survives a restart and is what you grep during an incident; it is
 * also invisible from the Langfuse UI, where the rest of a turn's cost and
 * latency already lives, and it cannot be aggregated into a p95 across a day of
 * traffic. Both surfaces, one source.
 *
 * Zero-duration observation on purpose: the stages it describes have already
 * run, and giving it a span would draw a bar that overlaps the real ones and
 * means something different. Soft-fails and skips itself when nothing is being
 * traced, exactly like `recordCandidateScores` — telemetry never delays or
 * breaks a turn.
 */
export const recordTimingsOnTrace = (
  name: string,
  timings: StageTimings,
): void => {
  if (!langfuseEnabled || getActiveSpanId() === undefined) return;
  try {
    startObservation(name, { metadata: { ...timings } }).end();
  } catch {
    // Swallow — a turn must never fail on its own instrumentation.
  }
};
