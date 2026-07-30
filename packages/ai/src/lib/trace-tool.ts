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
 * Open a NAMED standalone trace for a background operation that runs outside
 * any turn (memory dreaming, mention extraction, auto-title).
 *
 * The name is load-bearing, not decoration, and it MUST come from an opened
 * observation. Two mechanisms that look like they would name it do not:
 *   - `telemetryFor("memory-extract")` — AI SDK v7 hardcodes the span name to
 *     `invoke_agent <model>` / `chat <model>` and carries the functionId as the
 *     `gen_ai.agent.name` attribute instead;
 *   - `propagateAttributes({ traceName })` alone — a v3 trace-level concept; on
 *     a v4 server the root observation keeps its own name (verified against
 *     4.0.0: a bare `generateText` under `traceName: "memory-extract"` still
 *     lands as `invoke_agent openai/gpt-oss-20b`).
 * Without this wrapper these operations are indistinguishable from each other
 * in the UI — measured 2026-07-30: 353 such roots over 3 days, 13 of the 23
 * documented trace names absent from the data entirely.
 *
 * Use `withTraceSession` instead for work that JOINS an existing trace (a tool
 * inside a turn): opening a named observation there would nest a redundant
 * level under the turn.
 */
export const withNamedTrace = async <T>(
  name: string,
  attrs: {
    sessionId?: string;
    userId?: string;
    metadata?: Record<string, string>;
    tags?: string[];
  },
  fn: () => Promise<T>,
): Promise<T> => {
  if (!langfuseEnabled) return fn();
  return startActiveObservation(
    name,
    () =>
      propagateAttributes(
        {
          traceName: name,
          ...(attrs.sessionId !== undefined
            ? { sessionId: attrs.sessionId }
            : {}),
          ...(attrs.userId !== undefined ? { userId: attrs.userId } : {}),
          ...(attrs.metadata !== undefined ? { metadata: attrs.metadata } : {}),
          ...(attrs.tags !== undefined ? { tags: attrs.tags } : {}),
        },
        fn,
      ),
    { asType: "agent" },
  );
};

/**
 * A `withNamedTrace` whose subject grouping is mandatory: every AI call inside
 * `fn` nests under ONE named `agent` observation instead of scattering into
 * sibling roots (a document's vectorisation = 1 `vectorize` trace with N
 * enrichment + 1 embeddings child, not N+1 roots), grouped by `sessionId`.
 */
export const withPipelineTrace = async <T>(
  name: string,
  sessionId: string,
  attrs: { metadata?: Record<string, string>; tags?: string[] },
  fn: () => Promise<T>,
): Promise<T> => withNamedTrace(name, { sessionId, ...attrs }, fn);

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
            // `model` is load-bearing for cost, not decoration: Langfuse v4
            // only ingests `costDetails` on an observation that carries a
            // model name (verified against 4.0.0 — a cost-only update lands
            // as `{}` in the events tables, while the same update with any
            // model string is kept verbatim). These are not model calls, so
            // the priced unit is the call itself.
            ...(t.costUsd !== undefined
              ? { model: name, costDetails: { total: t.costUsd } }
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
