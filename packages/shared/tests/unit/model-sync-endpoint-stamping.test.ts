import { afterEach, describe, expect, test } from "bun:test";
import { fetchGatewayEndpoints } from "../../src/services/model-registry/sync/sources/gateway-endpoints";
import { fetchOpenRouterEndpoints } from "../../src/services/model-registry/sync/sources/openrouter-endpoints";

/**
 * What the endpoint readers record about their OWN evidence.
 *
 * Both payloads below are shaped from live responses. The OpenRouter one is
 * the failure that started this: its `/endpoints` route is public but its
 * PERCENTILES ARE NOT, so an unauthenticated call returns HTTP 200, a complete
 * endpoint list, and `throughput_last_30m: null` on every one. Nothing about
 * the response says anything went wrong. Run in a container without the key,
 * the nightly sync blanked the measured percentiles of the entire published
 * fleet — 0 of 145 endpoints, twice — and reported `ok`.
 *
 * The defence is `measuredAt`: a stamp written only when a measurement
 * actually arrived. It is what lets the carry-forward keep yesterday's figures
 * over today's nulls, and what lets a reader tell a fresh number from a kept
 * one.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Same shape as the AA suite's stub: `Object.assign` keeps `preconnect`, which `typeof fetch` requires. */
const respondWith = (body: unknown, status = 200): void => {
  const stub = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  globalThis.fetch = Object.assign(stub, {
    preconnect: realFetch.preconnect.bind(realFetch),
  });
};

const openRouterEndpoint = (over: Record<string, unknown> = {}) => ({
  provider_name: "DeepInfra",
  tag: "deepinfra/fp8",
  context_length: 200_000,
  max_completion_tokens: 16_000,
  pricing: { prompt: "0.0000004", completion: "0.0000016" },
  supported_parameters: ["tools"],
  ...over,
});

const gatewayEndpoint = (over: Record<string, unknown> = {}) => ({
  provider_name: "baseten",
  context_length: 200_000,
  // `prompt`/`completion`, like OpenRouter: both transports go through the
  // shared `endpointPricingSchema`, and an endpoint it cannot price is DROPPED
  // rather than zeroed — so a wrong key here silently empties the list.
  pricing: { prompt: "0.0000004", completion: "0.0000016" },
  supported_parameters: ["tools"],
  ...over,
});

describe("the OpenRouter endpoint reader", () => {
  test("stamps `measuredAt` when percentiles arrive", async () => {
    respondWith({
      data: {
        endpoints: [
          openRouterEndpoint({
            throughput_last_30m: { p50: 107, p90: 140 },
            latency_last_30m: { p50: 778, p90: 1200 },
          }),
        ],
      },
    });
    const [stat] = await fetchOpenRouterEndpoints("deepseek/deepseek-v4");
    expect(stat?.throughputP50).toBe(107);
    expect(stat?.measuredAt).toBeDefined();
  });

  test("leaves `measuredAt` ABSENT on the unauthenticated shape", async () => {
    // The production payload verbatim: 200 OK, a real endpoint, null
    // percentiles. Stamping it would claim we measured this host, and the
    // carry-forward would then let a real figure age out against a
    // measurement that never happened.
    respondWith({
      data: {
        endpoints: [
          openRouterEndpoint({
            throughput_last_30m: null,
            latency_last_30m: null,
          }),
        ],
      },
    });
    const [stat] = await fetchOpenRouterEndpoints("deepseek/deepseek-v4");
    expect(stat).toBeDefined();
    expect(stat?.throughputP50).toBeUndefined();
    expect(stat?.measuredAt).toBeUndefined();
  });

  test("maps p90 latency into its own field, never into p95", async () => {
    // This source publishes no p95 at all. Mapping nothing left the TTFT
    // ceiling permanently unevaluable for every OpenRouter row — a rule
    // nobody could fail. Writing p90 into `latencyP95Ms` would have been
    // worse: a fabricated value indistinguishable from a measured one.
    respondWith({
      data: {
        endpoints: [
          openRouterEndpoint({ latency_last_30m: { p50: 778, p90: 1200 } }),
        ],
      },
    });
    const [stat] = await fetchOpenRouterEndpoints("deepseek/deepseek-v4");
    expect(stat?.latencyP90Ms).toBe(1200);
    expect(stat?.latencyP95Ms).toBeUndefined();
  });
});

describe("the gateway endpoint reader", () => {
  test("stamps `measuredAt` when percentiles arrive", async () => {
    respondWith({
      data: {
        endpoints: [
          gatewayEndpoint({
            throughput_last_1h: { p50: 90, p95: 120 },
            latency_last_1h: { p50: 500, p95: 900 },
          }),
        ],
      },
    });
    const [stat] = await fetchGatewayEndpoints("deepseek/deepseek-v4");
    expect(stat?.throughputP50).toBe(90);
    expect(stat?.measuredAt).toBeDefined();
  });

  test("leaves an idle host unstamped", async () => {
    // A host with no recent traffic legitimately reports nulls here. Same
    // rule, different cause: nothing was measured, so nothing is claimed.
    respondWith({
      data: {
        endpoints: [
          gatewayEndpoint({
            throughput_last_1h: null,
            latency_last_1h: null,
          }),
        ],
      },
    });
    const [stat] = await fetchGatewayEndpoints("deepseek/deepseek-v4");
    // Guarded: an endpoint the reader DROPPED would also report an undefined
    // stamp, and would pass this assertion while testing nothing.
    expect(stat).toBeDefined();
    expect(stat?.measuredAt).toBeUndefined();
  });

  test("answers [] on 404 instead of throwing", async () => {
    // It used to throw, deliberately, to surface a row naming an id the
    // gateway had dropped. The asymmetry with OpenRouter was load-bearing in
    // the worst way: every row carries ids for every transport that ever
    // matched it and the sync enriches from all of them, so one withdrawn
    // gateway id turned every pass `partial` for a model another transport
    // was serving perfectly. Delisting is detected against the catalogue
    // LISTING instead, which a single 404 cannot distinguish from a hiccup.
    respondWith({ error: "not found" }, 404);
    expect(await fetchGatewayEndpoints("gone/model")).toEqual([]);
  });

  test("still throws on a real upstream failure", async () => {
    // A 500 says nothing about the model and everything about the source:
    // absorbing it would write a collapsed pool from data we never read.
    respondWith({ error: "boom" }, 500);
    expect(fetchGatewayEndpoints("deepseek/deepseek-v4")).rejects.toThrow();
  });
});
