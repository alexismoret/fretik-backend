/**
 * Langfuse tracing bootstrap.
 *
 * Registers the OpenTelemetry span processor that ships Vercel AI SDK
 * telemetry spans (model calls, tool calls, token usage, latency, cost)
 * to the self-hosted Langfuse instance. The app PUSHES traces to Langfuse
 * over outbound HTTPS — no inbound access to this service is required.
 *
 * Matches Langfuse's official production pattern for the Vercel AI SDK:
 * `LangfuseSpanProcessor` registered through a `NodeTracerProvider`
 * (NOT the lighter `NodeSDK` tutorial variant). See
 * https://langfuse.com/integrations/frameworks/vercel-ai-sdk
 *
 * **Import order matters.** This module must be imported before any model
 * call creates a telemetry span, so the global tracer provider is
 * registered first. `src/index.ts` imports it as its very first line.
 *
 * **No-op without credentials.** When the three `LANGFUSE_*` env vars are
 * absent (e.g. a local dev box with no Langfuse instance), nothing is
 * registered and `telemetryFor()` returns `undefined` — every model call
 * runs exactly as before, untouched.
 *
 * Env vars (read by the SDK; Bun auto-loads `.env`):
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL  — required
 *   OTEL_SERVICE_NAME             — optional but recommended (`fretik-ai`);
 *     unset, every observation carries `service.name=unknown_service:bun`.
 *     It must come from the ENVIRONMENT: OTel builds its default resource when
 *     `@opentelemetry/sdk-trace-node` is imported, i.e. before any statement in
 *     this module body could set it.
 *   LANGFUSE_TRACING_ENVIRONMENT  — optional; defaults to NODE_ENV-derived
 *   LANGFUSE_RELEASE              — optional; version stamp on every trace
 */
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry, type TelemetryOptions } from "ai";
import { langfuseMask } from "./langfuse-mask";

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL;

/**
 * True when all three credentials are present. Gates every Langfuse code
 * path so the integration is a strict no-op when unconfigured.
 */
export const langfuseEnabled = Boolean(publicKey && secretKey && baseUrl);

/**
 * Environment tag stamped on every trace / observation / score. Keeps dev
 * and prod data separate inside the same Langfuse project so local traffic
 * never pollutes production analytics. Filterable in the Langfuse UI.
 * Defaults from `NODE_ENV` when `LANGFUSE_TRACING_ENVIRONMENT` is unset.
 * Must match `^(?!langfuse)[a-z0-9-_]+$`, ≤40 chars.
 */
export const langfuseEnvironment =
  process.env.LANGFUSE_TRACING_ENVIRONMENT ??
  (process.env.NODE_ENV === "production" ? "production" : "development");

/**
 * Shared Langfuse client for the non-span HTTP APIs (score ingestion,
 * prompt management). Keeps its own batched queue, independent of the OTel
 * span exporter above. `undefined` when unconfigured, so every consumer
 * (`langfuse-scores.ts`, `langfuse-prompts.ts`) stays a strict no-op.
 */
export const langfuseClient = langfuseEnabled
  ? new LangfuseClient()
  : undefined;

/**
 * The single span processor instance — also the flush handle. `undefined`
 * when `langfuseEnabled` is false.
 */
export const langfuseSpanProcessor = langfuseEnabled
  ? new LangfuseSpanProcessor({
      environment: langfuseEnvironment,
      // Redact PII / secrets from every observation's input/output/metadata
      // before export. See lib/langfuse-mask.ts.
      mask: langfuseMask,
    })
  : undefined;

if (langfuseSpanProcessor) {
  // Register the span processor globally so exported spans reach Langfuse
  // via the global OTel tracer.
  new NodeTracerProvider({
    spanProcessors: [langfuseSpanProcessor],
  }).register();
  // AI SDK v7 uses a callback-based telemetry system: register the
  // Langfuse-owned integration so `generateText`/`streamText`/`ToolLoopAgent`
  // telemetry events become costed Langfuse observations (model + tool spans),
  // nested under whatever parent span `propagateAttributes` opened
  // (`chatbot-turn`, `workflow-turn`, pipeline traces). Telemetry is then ON by
  // default for every SDK call; `telemetry.isEnabled: false` opts a call out.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  console.log(
    `[langfuse] tracing enabled — environment=${langfuseEnvironment} host=${baseUrl ?? "?"}`,
  );
}

/**
 * Telemetry config for a model call. Pass the result straight to a
 * `streamText` / `generateText` / `ToolLoopAgent` `telemetry` field.
 * Returns `undefined` (telemetry off) when Langfuse is unconfigured.
 *
 * `functionId` groups telemetry by call site in the Langfuse UI — use a
 * stable, descriptive id (`agent:chatbot`, `compaction`, `pre-extract`).
 * Session / user / tags are attached separately via `propagateAttributes`
 * at the call site (they vary per request). `isEnabled` is omitted: v7
 * telemetry is on by default once the integration above is registered.
 */
export const telemetryFor = (
  functionId: string,
  /**
   * Top-level `runtimeContext` keys to expose to telemetry (all excluded by
   * default in v7). The agent passes `{ langfusePrompt: true }` so the Langfuse
   * integration can link the generation to its managed prompt version; no other
   * key is opted in, so nothing else leaks onto the span.
   */
  includeRuntimeContext?: TelemetryOptions["includeRuntimeContext"],
): TelemetryOptions | undefined =>
  langfuseEnabled
    ? {
        functionId,
        recordInputs: true,
        recordOutputs: true,
        ...(includeRuntimeContext ? { includeRuntimeContext } : {}),
      }
    : undefined;

/**
 * Flush buffered spans to Langfuse. Call at the end of a turn (so a trace
 * appears promptly, not only on the batch interval) and on shutdown.
 * Soft-fails: a flush error must never break the response path.
 */
export const flushLangfuse = async (): Promise<void> => {
  if (!langfuseSpanProcessor) return;
  try {
    await langfuseSpanProcessor.forceFlush();
  } catch (err) {
    console.warn(
      "[langfuse] forceFlush failed:",
      err instanceof Error ? err.message : err,
    );
  }
};
