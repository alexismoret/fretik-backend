import type {
  EndpointStat,
  TransportId,
} from "../../../../model-registry/types";
import { fetchJson } from "./wire";
import type { ProbeVerdict } from "./zdr-probe";
import { probeGatewayProviderReachable } from "./zdr-probe";

/**
 * "Is this one upstream serving this model again?", asked on whichever
 * transport the quarantine was recorded against.
 *
 * A quarantine's release date is a REVIEW TRIGGER, not an amnesty: something
 * has to go and check before a host that was corrupting output is allowed back
 * into a pool. That check was hardwired to the gateway — it read
 * `row.modelIds.gateway`, returned early when there was none, and posted to the
 * gateway's completions URL regardless of where the quarantine came from. On a
 * fleet that routes almost entirely through OpenRouter, that meant almost no
 * quarantine was ever re-probed: the entry sat on the row past its release
 * date, stopped filtering (every reader compares `releaseAt` to now), and was
 * never cleaned up. The host came back silently, unverified, and the row kept
 * a stale record of a decision nobody had revisited.
 *
 * The registry shape is `sourceForTransport`'s, deliberately, including its
 * most important property: `undefined` IS AN ANSWER. Scaleway serves each model
 * from one host, so there is no second host to pin against and nothing a probe
 * could distinguish — asking anyway would return "yes" for a model that is
 * simply still served, which is not the question. The caller handles the
 * absence explicitly rather than treating it as a failure.
 */

/** Long enough for a cold upstream, short enough not to stall a fleet sweep. */
const PROBE_TIMEOUT_MS = 15_000;

const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

/**
 * A refusal we can attribute to ROUTING POLICY rather than to infrastructure.
 *
 * The distinction is the whole point of the third answer: a 429 or a 502 says
 * nothing about the host's willingness to serve, and recording it as a refusal
 * would extend a quarantine forever on the strength of a bad minute.
 */
const isPolicyRefusal = (detail: string): boolean => {
  const lower = detail.toLowerCase();
  return (
    lower.includes("no_providers_available") ||
    lower.includes("no endpoints found") ||
    lower.includes("no allowed providers") ||
    lower.includes("match the 'only' filter")
  );
};

const probeOpenRouter = async (
  modelId: string,
  wireName: string,
): Promise<ProbeVerdict | undefined> => {
  const apiKey = Bun.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;

  const result = await fetchJson(OPENROUTER_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
      // Pinned to the one host: a success has to mean THAT provider answered,
      // not that the pool quietly routed around it. `allow_fallbacks: false` is
      // what makes the pin binding here — without it OpenRouter treats `only`
      // as a preference and serving from anywhere would read as a clean probe.
      provider: { only: [wireName], allow_fallbacks: false },
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (result.ok) return { ok: true, detail: "request accepted" };
  if (isPolicyRefusal(result.detail)) {
    return {
      ok: false,
      detail: `openrouter refused (${result.status.toString()}): ${result.detail}`,
    };
  }
  return undefined;
};

/** One transport's answer to "is this host serving again?". */
export interface ProviderProbe {
  transport: TransportId;
  /** `wireName` is what THIS transport's filter expects, never our identity name. */
  probe: (
    modelId: string,
    wireName: string,
  ) => Promise<ProbeVerdict | undefined>;
}

const PROBES: readonly ProviderProbe[] = [
  { transport: "gateway", probe: probeGatewayProviderReachable },
  { transport: "openrouter", probe: probeOpenRouter },
];

/**
 * The probe for a transport, or `undefined` when that transport cannot answer
 * the question — a real answer, not an error.
 *
 * `scaleway` is absent because it serves each model from a single host: there
 * is nothing to pin and nothing to distinguish. `custom` is absent because a
 * base URL somebody typed in is not something we can reason about.
 */
export const probeForTransport = (
  transport: TransportId,
): ProviderProbe | undefined =>
  PROBES.find((entry) => entry.transport === transport);

/**
 * What THIS transport's provider filter expects for a host, from the endpoints
 * the sync recorded.
 *
 * Not the same string as our identity name, and sending the wrong one fails in
 * the two worst ways available: the gateway rejects the request outright, and
 * OpenRouter accepts the unknown name and ignores it. Measured 2026-08-29, the
 * two catalogues disagree on `together`/`togetherai`, `bedrock`/
 * `amazon-bedrock`, `claudeaws`/`claude-on-aws`, `google`/`google-ai-studio`.
 *
 * This is exactly the bug the re-probe carried: it passed the identity name
 * straight into `only`, so for any host the catalogues spell differently the
 * probe was a request the transport rejected — read as "still refuses", and
 * the quarantine extended by another week, forever.
 *
 * `undefined` rather than a fallback to the identity name: a probe that cannot
 * be addressed correctly must not run at all, because its refusal would be
 * indistinguishable from the host's.
 */
export const wireNameFor = (
  endpoints: readonly EndpointStat[] | null,
  provider: string,
  transport: TransportId,
): string | undefined =>
  endpoints?.find((endpoint) => endpoint.provider === provider)?.wireNames[
    transport
  ];
