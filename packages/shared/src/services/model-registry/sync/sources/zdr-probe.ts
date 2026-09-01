import { fetchJson } from "./wire";

/**
 * The only honest zero-retention signal: make a zero-retention request.
 *
 * The gateway does not publish per-model ZDR eligibility for the pool a call
 * would actually route through — its catalogue says `all` / `some` / `none`,
 * and `some` covers "one obscure host qualifies, none of the three we route to
 * does". The only thing that answers the real question is a real request under
 * `zeroDataRetention: true`: the gateway either serves it or refuses with
 * `no_providers_available`.
 *
 * So the probe costs one token and tells the truth. It is a `max_tokens: 1`
 * completion, which is also why it is safe to run nightly across the fleet.
 *
 * THE THIRD ANSWER IS THE IMPORTANT ONE. `undefined` means UNVERIFIED, not
 * failed: no key, a timeout, a 429, a 502. An infrastructure blip must never be
 * recorded as "this model lost ZDR", because that reading disables models. The
 * policy treats an absent probe as a SOFT failure and a refused one as a HARD
 * failure — the difference between "we could not check" and "we checked and it
 * is gone" is the whole reason this returns three values instead of a boolean.
 */

const COMPLETIONS_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Long enough for a cold upstream, short enough not to stall a fleet sweep. */
const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeVerdict {
  ok: boolean;
  detail: string;
}

/** A refusal we can attribute to routing policy rather than to infrastructure. */
const isPolicyRefusal = (detail: string): boolean => {
  const lower = detail.toLowerCase();
  return lower.includes("no_providers_available") || lower.includes("no zdr");
};

const probe = async (
  model: string,
  gatewayOptions: Record<string, unknown>,
): Promise<ProbeVerdict | undefined> => {
  const apiKey = Bun.env.AI_GATEWAY_API_KEY;
  if (!apiKey) return undefined;

  const result = await fetchJson(COMPLETIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
      providerOptions: { gateway: gatewayOptions },
    }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (result.ok) return { ok: true, detail: "request accepted" };
  if (isPolicyRefusal(result.detail)) {
    return {
      ok: false,
      detail: `gateway refused (${result.status.toString()}): ${result.detail}`,
    };
  }
  // Network error, rate limit, upstream 5xx — we learned nothing.
  return undefined;
};

/**
 * Can this model still be served under zero retention?
 * `{ok:true}` served · `{ok:false}` refused on policy grounds · `undefined`
 * unverified (no key, or a failure that says nothing about ZDR).
 */
export const probeZeroDataRetention = async (
  gatewayModelId: string,
): Promise<ProbeVerdict | undefined> =>
  probe(gatewayModelId, { zeroDataRetention: true });

/**
 * Is one specific upstream serving this model again ON THE GATEWAY? The
 * gateway's half of the release re-probe — same minimal completion, pinned to
 * the one host with `only`, so a success means THAT provider answered rather
 * than the pool having quietly routed around it. `undefined` is unverified
 * here too: a quarantine is never lifted on a probe that did not run.
 *
 * `wireName` is what the GATEWAY's filter expects, not our identity name. The
 * two diverge on every host the catalogues spell differently, and the gateway
 * rejects an unknown name outright — a refusal indistinguishable from the
 * host's own, which is how this call used to extend a quarantine every week
 * forever. `sources/provider-probe.ts` resolves the name and picks the
 * transport; this function no longer decides either.
 */
export const probeGatewayProviderReachable = async (
  gatewayModelId: string,
  wireName: string,
): Promise<ProbeVerdict | undefined> =>
  probe(gatewayModelId, { only: [wireName] });
