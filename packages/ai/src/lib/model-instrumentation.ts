/**
 * The one seam every model in the service passes through.
 *
 * Two things ride here, and they are separate on purpose:
 *
 * - **Cost capture** — the exact per-call USD cost onto the Langfuse
 *   generation span (`lib/langfuse-cost.ts`). Kept out of
 *   `wrapModelWithCache` (`lib/openrouter-cache.ts`) so it applies uniformly to
 *   the cached chat models AND the raw single-purpose ones (vision, compaction
 *   summariser, multi-query, active-memory), instead of only to the models that
 *   opt into manual prompt caching. It needs an active observation, so wrapping
 *   an untraced model is a harmless no-op, as is running without Langfuse.
 *
 * - **Corruption detectors** (`lib/model-detectors.ts`) — UNCONDITIONAL. They
 *   are what lets a provider that starts mangling output be pulled from the
 *   pool within minutes instead of within a release, so they cannot be tied to
 *   whether an observability vendor happens to be configured. The previous
 *   incident of this kind ran for hours, self-propagating through conversation
 *   history, and was found by a person reading an answer.
 *
 * This function wraps all five model construction sites — the registry plus the
 * four services that build a client by hand — which is why it, and not the
 * registry, is where anything needing total coverage belongs.
 */
import { type EmbeddingModelV4, type LanguageModelV4 } from "@ai-sdk/provider";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import { langfuseEnabled } from "./langfuse";
import {
  costCaptureMiddleware,
  embeddingCostCaptureMiddleware,
} from "./langfuse-cost";
import { type DetectorContext, detectorMiddleware } from "./model-detectors";

/**
 * Instrument a model. For cached chat models, compose OUTSIDE the cache
 * wrapper so the detectors see what the provider actually sent:
 * `instrumentModel(wrapModelWithCache(client.chat(...)), ctx)`.
 *
 * `ctx` names the profile and transport so an incident can be attributed
 * without guessing. The four hand-built call sites pass nothing and fall back
 * to the model's own id, which is enough to record the finding even though it
 * has no live-state row to quarantine against.
 */
export const instrumentModel = (
  model: LanguageModelV4,
  ctx: DetectorContext = {},
): LanguageModelV4 =>
  wrapLanguageModel({
    model,
    middleware: langfuseEnabled
      ? [costCaptureMiddleware, detectorMiddleware(ctx)]
      : [detectorMiddleware(ctx)],
  });

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
