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
 * Write the cost onto the currently active Langfuse generation. Soft-fail:
 * telemetry must never break a model call.
 */
const writeCost = (
  providerMetadata: SharedV4ProviderMetadata | undefined,
): void => {
  const cost = extractOpenRouterCost(providerMetadata);
  if (cost === undefined) return;
  // No active observation → this model call isn't traced (no
  // `experimental_telemetry`), so there's no generation to attach cost to.
  // Skip silently — otherwise `updateActiveObservation` logs a "no active
  // span" warning on every untraced call. This is what makes
  // `instrumentModel` safe to apply uniformly to every model.
  if (getActiveSpanId() === undefined) return;
  try {
    updateActiveObservation(
      { costDetails: { total: cost } },
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
    writeCost(result.providerMetadata);
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
              writeCost(part.providerMetadata);
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
