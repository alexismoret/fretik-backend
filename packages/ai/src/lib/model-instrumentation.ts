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
import { type LanguageModelV3 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { langfuseEnabled } from "./langfuse";
import { costCaptureMiddleware } from "./langfuse-cost";

/**
 * Attach Langfuse cost capture to a model. For cached chat models,
 * compose OUTSIDE the cache wrapper:
 * `instrumentModel(wrapModelWithCache(openrouter.chat(...)))`.
 */
export const instrumentModel = (model: LanguageModelV3): LanguageModelV3 =>
  langfuseEnabled
    ? wrapLanguageModel({ model, middleware: [costCaptureMiddleware] })
    : model;
