import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import { langfuseEnabled } from "./langfuse";

/**
 * Group every Langfuse observation created inside `fn` under a `sessionId`
 * (+ optional tags / metadata). Used to tie a document's processing pipeline
 * — OCR, pre-extraction, vectorisation — to one session keyed on the document
 * (`documents:{id}`), and chat-file OCR to its conversation. These are
 * standalone (non-chat) pipeline traces otherwise; the session makes the
 * Sessions view show the full per-subject cost/timeline. A no-op when
 * Langfuse is unconfigured. The traces are a historical cost record — never
 * delete them when the underlying file/document is deleted.
 */
export const withTraceSession = async <T>(
  sessionId: string,
  attrs: { metadata?: Record<string, string>; tags?: string[] },
  fn: () => Promise<T>,
): Promise<T> => {
  if (!langfuseEnabled) return fn();
  return propagateAttributes(
    {
      sessionId,
      ...(attrs.metadata !== undefined ? { metadata: attrs.metadata } : {}),
      ...(attrs.tags !== undefined ? { tags: attrs.tags } : {}),
    },
    fn,
  );
};

/**
 * Like `withTraceSession`, but ALSO opens a single parent `agent` observation
 * named `name` so every AI call inside `fn` nests under ONE trace instead of
 * scattering into many sibling roots (e.g. a document's vectorisation = 1
 * `vectorize` trace with N enrichment + 1 embeddings child, not N+1 roots).
 * Keeps the per-subject `sessionId` grouping. No-op when Langfuse is off.
 */
export const withPipelineTrace = async <T>(
  name: string,
  sessionId: string,
  attrs: { metadata?: Record<string, string>; tags?: string[] },
  fn: () => Promise<T>,
): Promise<T> => {
  if (!langfuseEnabled) return fn();
  return startActiveObservation(
    name,
    () => withTraceSession(sessionId, attrs, fn),
    { asType: "agent" },
  );
};

/** What an external call reports back for its Langfuse observation. */
export interface ExternalCallTrace {
  /**
   * Estimated USD cost. Rolled into Langfuse cost dashboards — Langfuse only
   * aggregates cost on `generation`/`embedding` observations, which is why
   * these non-LLM calls are traced as `generation` (with 0 tokens, so token
   * metrics stay unaffected). Omit when no cost estimate is available.
   */
  costUsd?: number;
  /** Output summary shown on the observation. */
  output?: Record<string, unknown>;
  /** Extra metadata (credits, duration, tier, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Trace an external, non-LLM AI-adjacent call (E2B sandbox exec, Tavily web
 * search/fetch) as a Langfuse `generation` so its ESTIMATED cost rolls into
 * the unified cost view. Nests under the active chatbot-turn trace (these only
 * run inside agent tool steps), so no orphan/session pollution. No-op when
 * Langfuse is unconfigured; soft-fail — a tracing error never breaks the call.
 *
 * `summarize` receives the result and the measured wall-clock duration (ms) so
 * per-second-billed calls (E2B) can derive their cost.
 */
export const traceExternalCall = async <T>(
  name: string,
  input: Record<string, unknown>,
  run: () => Promise<T>,
  summarize: (result: T, durationMs: number) => ExternalCallTrace,
): Promise<T> => {
  if (!langfuseEnabled) return run();
  const start = Date.now();
  return startActiveObservation(
    name,
    async () => {
      const result = await run();
      const durationMs = Date.now() - start;
      try {
        const t = summarize(result, durationMs);
        updateActiveObservation(
          {
            input,
            ...(t.output !== undefined ? { output: t.output } : {}),
            ...(t.metadata !== undefined ? { metadata: t.metadata } : {}),
            ...(t.costUsd !== undefined
              ? { costDetails: { total: t.costUsd } }
              : {}),
          },
          { asType: "generation" },
        );
      } catch {
        // Telemetry must never break the underlying call.
      }
      return result;
    },
    { asType: "generation" },
  );
};
