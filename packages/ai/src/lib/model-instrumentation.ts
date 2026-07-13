/**
 * Model cost instrumentation, decoupled from prompt caching.
 *
 * Wraps a language model with `costCaptureMiddleware` so OpenRouter's
 * exact per-call USD cost lands on the Langfuse generation span (see
 * `lib/langfuse-cost.ts`). Kept SEPARATE from `wrapModelWithCache`
 * (`lib/openrouter-cache.ts`) so cost capture applies UNIFORMLY to every
 * model — the cached chat models AND the raw single-purpose models
 * (vision, compaction summariser, multi-query, active-memory) — instead
 * of only the models that opt into manual prompt caching.
 *
 * Cost only materialises when the call also emits a generation span
 * (`experimental_telemetry`): the middleware writes the cost onto the
 * active observation, which `costCaptureMiddleware` skips when none
 * exists. So wrapping an untraced model is a harmless no-op. No-op too
 * when Langfuse is unconfigured.
 */
import { type EmbeddingModelV4, type LanguageModelV4 } from "@ai-sdk/provider";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import { langfuseEnabled } from "./langfuse";
import {
  costCaptureMiddleware,
  embeddingCostCaptureMiddleware,
} from "./langfuse-cost";

/**
 * Attach Langfuse cost capture to a model. For cached chat models,
 * compose OUTSIDE the cache wrapper:
 * `instrumentModel(wrapModelWithCache(openrouter.chat(...)))`.
 */
export const instrumentModel = (model: LanguageModelV4): LanguageModelV4 =>
  langfuseEnabled
    ? wrapLanguageModel({ model, middleware: [costCaptureMiddleware] })
    : model;

/**
 * Embedding-model counterpart of `instrumentModel`: attaches the embedding
 * cost middleware (cost onto the `embedding` observation + 20-input batching)
 * so `embed`/`embedMany` calls land their OpenRouter cost on the trace.
 * A no-op when Langfuse is unconfigured.
 */
export const instrumentEmbeddingModel = (
  model: EmbeddingModelV4,
): EmbeddingModelV4 =>
  langfuseEnabled
    ? wrapEmbeddingModel({
        model,
        middleware: [embeddingCostCaptureMiddleware],
      })
    : model;
