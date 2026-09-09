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
