/**
 * Passive telemetry — what our OWN traffic knows about the upstreams we route to.
 *
 * Every number the registry grades a model on is a vendor's claim about its own
 * service: a throughput aggregated over everybody's traffic, a latency measured
 * from somewhere else, an uptime nobody can audit. It was the only option while
 * nothing recorded what we saw ourselves, and on 2026-09-01 its fragility
 * became concrete — one lapsed credential blanked the whole fleet's percentiles
 * while every dashboard still read `ok`.
 *
 * Meanwhile 100 % of registry traffic already flowed through
 * `instrumentModel`, where the serving upstream, the token counts, the cost and
 * the finish reason are all in hand. None of it was written down. This
 * middleware writes it down.
 *
 * Three properties are load-bearing:
 *
 * - **UNCONDITIONAL**, unlike the cost middleware next to it. That one only
 *   attaches when Langfuse is configured, which is correct for a Langfuse
 *   span and would be a disaster here: the registry's own grading may not
 *   depend on whether an observability vendor happens to be wired up.
 * - **NEVER COSTS A TURN.** Writes are fire-and-forget behind a `.catch`, the
 *   sink swallows its own failures, and the hot path is a timestamp per stream
 *   and a counter per call. Losing an hour of telemetry costs the registry a
 *   little evidence; a failed write reaching a customer's stream costs them
 *   their answer.
 * - **NO TEXT, EVER.** Counts, durations, token totals and a host name. These
 *   streams are customer conversations, and a performance metric is not a
 *   licence to copy them into an infra table — the same rule the corruption
 *   detectors follow.
 *
 * It also, as a by-product, gives the `stall` incident kind its first
 * producer: watching inter-delta gaps is exactly what a TTFT tap already does,
 * and `stall` had been declared with a threshold and no detector since the
 * breaker was written.
 */
import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { TransportId } from "@fretik/shared/model-registry/types";
import { reportIncident } from "@fretik/shared/services/model-registry/breaker";
import { recordCall } from "@fretik/shared/services/model-registry/telemetry";
import { TransformStream } from "node:stream/web";
import { extractGatewayReport } from "./model-registry/transports/gateway";
import { extractOpenRouterReport } from "./model-registry/transports/openrouter";
import { extractScalewayReport } from "./model-registry/transports/scaleway";

export interface TelemetryContext {
  /** The stable key teams store. Without it there is nothing to attribute to. */
  profileKey?: string;
  transport?: TransportId;
  /** Prices a call for a transport that puts no cost on the wire. */
  estimateCostUsd?: (usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  }) => number | undefined;
}

/**
 * A gap between two tokens long enough that the stream has stopped rather than
 * slowed. The slowest host in the published fleet decodes at ~20 tok/s, so 45 s
 * of silence mid-answer is three orders of magnitude outside normal and is what
 * a dropped connection looks like from here.
 *
 * Distinct from `upstream-cut`, which is a call that ENDED without anybody
 * choosing to. A stall is a call that has not ended and is not producing —
 * the shape the breaker's `stall` kind was declared for and never had a
 * detector to feed it.
 */
const STALL_GAP_MS = 45_000;

/**
 * The upstream that actually served, through the adapters rather than by hand,
 * so the name matches the pool and the quarantine key exactly. A near-miss
 * (`DeepInfra` against `deepinfra`) attributes to a host nothing else knows.
 *
 * Scaleway is in the chain now. It reports no provider — one host, nothing to
 * disambiguate — so its adapter answers with the constant, which is a
 * structural fact rather than an invented measurement. Without it every
 * Scaleway call was unattributable, and therefore invisible to both the
 * breaker and this.
 */
const servingProvider = (
  metadata: SharedV4ProviderMetadata | undefined,
): string | undefined =>
  extractGatewayReport(metadata).servingProvider ??
  extractOpenRouterReport(metadata).servingProvider ??
  extractScalewayReport(metadata).servingProvider;

const reportedCost = (
  metadata: SharedV4ProviderMetadata | undefined,
): number | undefined =>
  extractGatewayReport(metadata).costUsd ??
  extractOpenRouterReport(metadata).costUsd;

/** What the sink needs, flattened out of the SDK's nested usage shape. */
interface FlatUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

const finite = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The SDK reports usage as two nested breakdowns — input split by cache state,
 * output split into text and reasoning. `lib/langfuse-cost.ts` reads the same
 * fields the same way; both need the totals, and REASONING TOKENS COUNT as
 * output here on purpose: they are tokens the host decoded, so leaving them
 * out would understate the throughput of exactly the models that produce most
 * of them.
 */
const flattenUsage = (usage: LanguageModelV4Usage | undefined): FlatUsage => {
  const reasoning = finite(usage?.outputTokens?.reasoning);
  const text = finite(usage?.outputTokens?.text);
  const outputTokens = (reasoning ?? 0) + (text ?? 0) || undefined;
  return {
    ...(finite(usage?.inputTokens?.total) === undefined
      ? {}
      : { inputTokens: finite(usage?.inputTokens?.total) }),
    ...(finite(usage?.inputTokens?.cacheRead) === undefined
      ? {}
      : { cachedInputTokens: finite(usage?.inputTokens?.cacheRead) }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
};

interface FinishedCall {
  metadata: SharedV4ProviderMetadata | undefined;
  usage: FlatUsage;
  durationMs: number;
  ttftMs?: number;
  errored: boolean;
}

/**
 * Hand one finished call to the sink. Attribution is required: a measurement
 * with no upstream cannot inform a pool decision, and averaging it into
 * "somebody" would corrupt the hosts it got mixed with.
 */
const record = (call: FinishedCall, ctx: TelemetryContext): void => {
  const { profileKey, transport } = ctx;
  if (profileKey === undefined || transport === undefined) return;
  const provider = servingProvider(call.metadata);
  if (provider === undefined) return;

  const costUsd =
    reportedCost(call.metadata) ?? ctx.estimateCostUsd?.(call.usage);

  void recordCall({
    profileKey,
    provider,
    transport,
    durationMs: call.durationMs,
    ...(call.ttftMs === undefined ? {} : { ttftMs: call.ttftMs }),
    ...(call.usage.outputTokens === undefined
      ? {}
      : { outputTokens: call.usage.outputTokens }),
    ...(call.usage.inputTokens === undefined
      ? {}
      : { inputTokens: call.usage.inputTokens }),
    ...(call.usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: call.usage.cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    errored: call.errored,
  }).catch((err: unknown) => {
    console.warn(
      "[model-telemetry] sink rejected:",
      err instanceof Error ? err.message : err,
    );
  });
};

/** A stall, filed once per stream, fire-and-forget like every other incident. */
const fileStall = (
  ctx: TelemetryContext,
  provider: string,
  gapMs: number,
): void => {
  const { profileKey, transport } = ctx;
  if (profileKey === undefined || transport === undefined) return;
  void reportIncident({
    modelKey: profileKey,
    provider,
    transport,
    kind: "stall",
    evidence: { gapMs: Math.round(gapMs) },
  }).catch((err: unknown) => {
    console.error(
      "[model-telemetry] stall filing failed:",
      err instanceof Error ? err.message : err,
    );
  });
};

/**
 * Measure every call. Attach unconditionally — see the header.
 *
 * TTFT is taken at the FIRST TEXT DELTA and only for streams. A non-streamed
 * call has no first token to observe, and recording its total duration as a
 * latency would quietly turn a TTFT percentile into a length percentile: the
 * two look identical in a column and mean opposite things.
 */
export const telemetryMiddleware = (
  ctx: TelemetryContext,
): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  // A THROW is deliberately not caught here. It is a real outcome for a host,
  // but it arrives with no `providerMetadata`, so there is no upstream to
  // attribute it to — and charging it to the wrong host is worse than not
  // counting it. Transport-level failures surface through the breaker and the
  // run's own error handling instead.
  wrapGenerate: async ({ doGenerate }) => {
    const startedAt = Date.now();
    const result = await doGenerate();
    record(
      {
        metadata: result.providerMetadata,
        usage: flattenUsage(result.usage),
        durationMs: Date.now() - startedAt,
        errored: result.finishReason?.unified === "error",
      },
      ctx,
    );
    return result;
  },
  wrapStream: async ({ doStream }) => {
    const startedAt = Date.now();
    const { stream, ...rest } = await doStream();
    let ttftMs: number | undefined;
    let lastPartAt = startedAt;
    let longestGapMs = 0;
    let metadata: SharedV4ProviderMetadata | undefined;
    let recorded = false;

    /**
     * The stall is filed at the END, not where it is observed, and that is
     * forced by the wire rather than chosen: in practice `providerMetadata`
     * only arrives on the `finish` part, so mid-stream there is no host to
     * name — and an incident naming nobody quarantines nobody. Remembering the
     * longest silence and judging it once the upstream is known files exactly
     * the same finding against exactly the right host.
     *
     * The case this cannot reach is a stream that goes quiet and never comes
     * back: no `finish`, no metadata, nothing to attribute. That one is
     * already `upstream-cut`'s job, and it has the same blind spot for the
     * same reason.
     */
    const settle = (at: number, usage: FlatUsage, errored: boolean): void => {
      recorded = true;
      const provider = servingProvider(metadata);
      if (provider !== undefined && longestGapMs > STALL_GAP_MS) {
        fileStall(ctx, provider, longestGapMs);
      }
      record(
        {
          metadata,
          usage,
          durationMs: at - startedAt,
          ...(ttftMs === undefined ? {} : { ttftMs }),
          errored,
        },
        ctx,
      );
    };

    const tapped = stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            const at = Date.now();
            const isFirstToken =
              part.type === "text-delta" && ttftMs === undefined;
            if (isFirstToken) ttftMs = at - startedAt;
            // Gaps are measured between PARTS, not only between text deltas: a
            // reasoning stream emits nothing else for minutes at a time, and
            // reading that as a stall would quarantine every thinking model.
            //
            // Only AFTER the first token, and never ON it. A slow first token
            // is latency — a cold start, a queue — which TTFT already
            // measures; counting it here would file a stall against every host
            // that ever kept us waiting before answering at all.
            if (ttftMs !== undefined && !isFirstToken) {
              longestGapMs = Math.max(longestGapMs, at - lastPartAt);
            }
            lastPartAt = at;

            if ("providerMetadata" in part && part.providerMetadata) {
              metadata = part.providerMetadata;
            }
            if (part.type === "finish") {
              settle(
                at,
                flattenUsage(part.usage),
                part.finishReason?.unified === "error",
              );
            }
            controller.enqueue(part);
          },
          flush: () => {
            // A stream that closes with no `finish` part is what a cut looks
            // like on the wire. It still measured something real — how long the
            // host ran and how far it got — and counting it as an error is the
            // point: a host that cuts often should rank below one that does
            // not, and a pool ordered on successful calls alone never sees it.
            if (recorded) return;
            settle(Date.now(), {}, true);
          },
        },
      ),
    );
    return { stream: tapped, ...rest };
  },
});
