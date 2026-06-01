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
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import { getActiveSpanId, updateActiveObservation } from "@langfuse/tracing";
import { TransformStream } from "node:stream/web";

/**
 * Pull OpenRouter's real cost (USD) out of a result's provider metadata
 * (`providerMetadata.openrouter.usage.cost`). Returns undefined when
 * absent / non-numeric (e.g. usage accounting disabled).
 */
const extractOpenRouterCost = (
  providerMetadata: SharedV3ProviderMetadata | undefined,
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
  providerMetadata: SharedV3ProviderMetadata | undefined,
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
 * AI SDK middleware that ingests OpenRouter's exact per-call cost onto the
 * Langfuse generation span. Attach only when Langfuse is configured.
 */
export const costCaptureMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    writeCost(result.providerMetadata);
    return result;
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const tapped = stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>(
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
