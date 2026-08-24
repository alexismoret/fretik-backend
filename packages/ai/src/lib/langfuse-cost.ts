/**
 * Langfuse cost capture for OpenRouter models (AI SDK middleware).
 *
 * OpenRouter returns the real USD cost of each request under
 * `providerMetadata.openrouter.usage.cost` (requires usage accounting —
 * `usage: { include: true }` in `lib/openrouter.ts`). Langfuse otherwise
 * only infers cost from its model-price table, which has no entry for
 * OpenRouter-routed models (e.g. MiniMax) — leaving cost at 0.
 *
 * The cost MUST be written while the AI SDK's generation span is the active
 * observation. A model middleware is the correct seam: `wrapGenerate` /
 * `wrapStream` run INSIDE that span's context — unlike a `streamText`
 * `onStepFinish`, which fires after the generation span has already closed
 * (verified: the cost write landed nowhere from there). We read the cost
 * from the result (non-streaming) or the `finish` stream part (streaming)
 * and write it via `updateActiveObservation`.
 *
 * The same seam carries the serving UPSTREAM (`extractOpenRouterProvider`):
 * it rides the same `providerMetadata` and is otherwise absent from the trace.
 *
 * Attached to models via `instrumentModel` (`lib/model-instrumentation.ts`)
 * only when Langfuse is configured; a no-op otherwise, and a no-op on any
 * model call that emits no generation span (see `writeCost`).
 */
import type {
  EmbeddingModelV4Middleware,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import {
  getActiveSpanId,
  startObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import { TransformStream } from "node:stream/web";

/**
 * Pull OpenRouter's real cost (USD) out of a result's provider metadata
 * (`providerMetadata.openrouter.usage.cost`). Returns undefined when
 * absent / non-numeric (e.g. usage accounting disabled).
 */
const extractOpenRouterCost = (
  providerMetadata: SharedV4ProviderMetadata | undefined,
): number | undefined => {
  const usage = providerMetadata?.openrouter?.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const cost = usage.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
};

/**
 * The UPSTREAM that actually served the call ("Groq", "Cerebras", "Amazon
 * Bedrock", …), from `providerMetadata.openrouter.provider`.
 *
 * OTel records `gen_ai.provider.name` as the literal `"openrouter"`, so
 * without this the serving upstream is nowhere in the trace — and OpenRouter
 * routes the same model id to a different one call to call. Recovering it
 * afterwards means replaying `gen_ai.response.id` against OpenRouter's
 * `/api/v1/generation` endpoint one call at a time (done by hand once, 2026-08:
 * the recall judge was silently split across three upstreams). Recorded on
 * every instrumented generation so provider-correlated behaviour is a filter in
 * the UI, not an investigation.
 */
const extractOpenRouterProvider = (
  providerMetadata: SharedV4ProviderMetadata | undefined,
): string | undefined => {
  const provider = providerMetadata?.openrouter?.provider;
  return typeof provider === "string" && provider.length > 0
    ? provider
    : undefined;
};

/**
 * Write the cost + serving upstream + reasoning share onto the currently
 * active Langfuse generation. Soft-fail: telemetry must never break a model
 * call.
 *
 * The reasoning split is written TWICE, on purpose. Providers fold reasoning
 * INTO the output count, so the stored `output` answers "what did this cost"
 * and never "what was it spent on" — and the second question is the one that
 * decides whether a role's reasoning effort is worth its price. Measured need
 * (2026-08-23): a page update emits ~11k output tokens to change 155 lines,
 * and nothing in the trace said how much of that was thinking.
 *
 * `usageDetails` is the aggregatable home — its keys are the metrics API's
 * `usageType` dimension, so a question like "what share of the page builder's
 * output is reasoning" is one query. It is also the one that may not survive:
 * the AI SDK's OTel integration writes its own usage block when it ENDS the
 * span, after this middleware has tapped `finish`. `metadata` is not
 * aggregatable — it is not a metrics dimension — but it always lands, and it
 * is readable per observation in the UI. Writing both costs nothing and leaves
 * no version of this instrument that reports silence.
 */
const writeCost = (
  providerMetadata: SharedV4ProviderMetadata | undefined,
  outputTokens?: { text: number | undefined; reasoning: number | undefined },
): void => {
  const cost = extractOpenRouterCost(providerMetadata);
  const provider = extractOpenRouterProvider(providerMetadata);
  const finite = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const reasoning = finite(outputTokens?.reasoning);
  const text = finite(outputTokens?.text);
  if (
    cost === undefined &&
    provider === undefined &&
    reasoning === undefined &&
    text === undefined
  ) {
    return;
  }
  // No active observation → this model call isn't traced (no
  // `experimental_telemetry`), so there's no generation to attach cost to.
  // Skip silently — otherwise `updateActiveObservation` logs a "no active
  // span" warning on every untraced call. This is what makes
  // `instrumentModel` safe to apply uniformly to every model.
  if (getActiveSpanId() === undefined) return;
  try {
    updateActiveObservation(
      {
        ...(cost !== undefined ? { costDetails: { total: cost } } : {}),
        ...(reasoning !== undefined || text !== undefined
          ? {
              usageDetails: {
                ...(reasoning !== undefined
                  ? { output_reasoning: reasoning }
                  : {}),
                ...(text !== undefined ? { output_answer: text } : {}),
              },
            }
          : {}),
        ...(provider !== undefined ||
        reasoning !== undefined ||
        text !== undefined
          ? {
              metadata: {
                ...(provider !== undefined
                  ? { openrouterProvider: provider }
                  : {}),
                ...(reasoning !== undefined
                  ? { reasoningTokens: reasoning }
                  : {}),
                ...(text !== undefined ? { answerTokens: text } : {}),
              },
            }
          : {}),
      },
      { asType: "generation" },
    );
  } catch {
    // Swallow — never let cost ingestion break the generation.
  }
};

/**
 * Embedding cost, as its own observation.
 *
 * `updateActiveObservation` does NOT work here. The AI SDK's OTel integration
 * opens the `embeddings <model>` span with `startSpan` under the call's root
 * context and never makes it the ACTIVE span — unlike a language-model call,
 * which runs inside `context.with(modelCallContext, execute)`. A cost update
 * from `wrapEmbed` therefore lands on whatever observation IS active: the
 * caller's pipeline parent (`vectorize`, …), which it also retypes to
 * `embedding` and which, across several batches, keeps only the last chunk's
 * cost. Verified on live traces.
 *
 * So emit a dedicated child instead — one per batch, aggregated by Langfuse at
 * trace/session level. It carries `model` because Langfuse v4 silently drops
 * `costDetails` on a model-less observation.
 */
const writeEmbeddingCost = (
  providerMetadata: SharedV4ProviderMetadata | undefined,
  modelId: string,
): void => {
  const cost = extractOpenRouterCost(providerMetadata);
  if (cost === undefined) return;
  // Untraced embed call → creating an observation here would open an orphan
  // root trace per batch. Same rationale as `writeCost`.
  if (getActiveSpanId() === undefined) return;
  try {
    startObservation(
      `embeddings ${modelId} cost`,
      { model: modelId, costDetails: { total: cost } },
      { asType: "embedding" },
    ).end();
  } catch {
    // Swallow — never let cost ingestion break the embedding call.
  }
};

/**
 * AI SDK middleware that ingests OpenRouter's exact per-call cost onto the
 * Langfuse generation span. Attach only when Langfuse is configured.
 */
export const costCaptureMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    writeCost(result.providerMetadata, result.usage.outputTokens);
    return result;
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const tapped = stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            // The terminal `finish` part carries the aggregated usage +
            // OpenRouter cost. Tapping it here runs inside the generation
            // span's context, so `updateActiveObservation` targets it.
            if (part.type === "finish") {
              writeCost(part.providerMetadata, part.usage.outputTokens);
            }
            controller.enqueue(part);
          },
        },
      ),
    );
    return { stream: tapped, ...rest };
  },
};

/**
 * Embedding-model counterpart of `costCaptureMiddleware`: ingests OpenRouter's
 * exact per-call cost as a dedicated `embedding` observation next to the one
 * `embed` / `embedMany` telemetry emits (see `writeEmbeddingCost` for why it
 * cannot be written onto that one). `overrideMaxEmbeddingsPerCall` keeps the
 * 20-input batch size of the previous raw-fetch path (one cost observation per
 * chunk → Langfuse aggregates them at the trace level). Attach via
 * `instrumentEmbeddingModel` only when Langfuse is configured.
 */
export const embeddingCostCaptureMiddleware: EmbeddingModelV4Middleware = {
  specificationVersion: "v4",
  overrideMaxEmbeddingsPerCall: () => 20,
  wrapEmbed: async ({ doEmbed, model }) => {
    const result = await doEmbed();
    writeEmbeddingCost(result.providerMetadata, model.modelId);
    return result;
  },
};
