import { describe, expect, test } from "bun:test";
import {
  extractGatewayReport,
  gatewayAdapter,
} from "../../../src/lib/model-registry/transports/gateway";
import {
  createOpenRouterAdapter,
  extractOpenRouterReport,
} from "../../../src/lib/model-registry/transports/openrouter";
import { scalewayAdapter } from "../../../src/lib/model-registry/transports/scaleway";
import type { TransportRequest } from "../../../src/lib/model-registry/transports/types";

/**
 * What each transport tells us a call cost, and what to do when one tells us
 * nothing.
 *
 * The payloads are copied from live generations on 2026-08-30 — one call per
 * transport against `gpt-oss-120b`, the one model all three serve — because the
 * question is what the UPSTREAM sends back and no invented fixture can answer
 * it. The measurement is the point: `extractReport` had never been checked
 * against a real gateway response, and Scaleway's `extractReport` was written
 * from reasoning before anyone had run a generation through it.
 */

const request = (pricing?: {
  inputPerMTok: number;
  outputPerMTok: number;
}): TransportRequest =>
  ({
    modelId: "gpt-oss-120b",
    endpoints:
      pricing === undefined
        ? []
        : [
            {
              provider: "scaleway",
              displayName: "Scaleway",
              wireNames: { scaleway: "scaleway" },
              contextLength: 128_000,
              pricing,
              supportedParameters: ["tools"],
            },
          ],
  }) as unknown as TransportRequest;

describe("what the transports report", () => {
  test("the gateway quotes its cost as a decimal STRING, plus the serving host", () => {
    // Verbatim from a live call: the cost is a string, and the host that served
    // it is under `routing.resolvedProvider` rather than anywhere obvious.
    const report = extractGatewayReport({
      gateway: {
        cost: "0.0000276",
        marketCost: "0.0000276",
        generationId: "gen_01M188RPXV71KKKWJRFHR75Z04",
        routing: { resolvedProvider: "baseten", finalProvider: "baseten" },
      },
    });
    expect(report.costUsd).toBeCloseTo(0.0000276, 12);
    expect(report.servingProvider).toBe("baseten");
    expect(report.generationId).toBe("gen_01M188RPXV71KKKWJRFHR75Z04");
  });

  test("OpenRouter quotes a NUMBER, under its own usage block", () => {
    const report = extractOpenRouterReport({
      openrouter: {
        provider: "AkashML",
        usage: { cost: 0.00001225, totalTokens: 133 },
      },
    });
    expect(report.costUsd).toBe(0.00001225);
    expect(report.servingProvider).toBe("akashml");
  });

  test("Scaleway quotes NO cost, and still names the host that served", () => {
    // The whole payload, measured over both the SDK and a raw HTTP call: no
    // cost field, no cost header, `prompt_tokens_details: null`. So `costUsd`
    // stays absent — `estimateCostUsd` supplies a DERIVED figure instead, and
    // inventing one here would be read downstream as measured.
    //
    // The serving host is a different question with a definite answer: this is
    // a direct provider with exactly one host, so naming it reads the
    // transport rather than guessing at a measurement. It was absent until
    // 2026-09-01, and the cost was a hole in the safety net rather than a gap
    // in a dashboard — the breaker quarantines a PROVIDER, so every Scaleway
    // finding was dropped as unattributable.
    const report = scalewayAdapter.extractReport({ scaleway: {} });
    expect(report.costUsd).toBeUndefined();
    expect(report.generationId).toBeUndefined();
    expect(report.servingProvider).toBe("scaleway");
  });

  test("Scaleway claims NOTHING about another transport's call", () => {
    // The readers try each extractor in turn and take the first answer, so an
    // unconditional one would catch every call the others failed to attribute
    // and file it against a host that never saw it. Misattribution is strictly
    // worse than no attribution: a quarantine acts on the name.
    expect(scalewayAdapter.extractReport({ gateway: { cost: "0.1" } })).toEqual(
      {},
    );
    expect(scalewayAdapter.extractReport(undefined)).toEqual({});
  });
});

describe("pricing a call nobody priced", () => {
  test("the stored rate and the reported tokens give the cost", () => {
    // gpt-oss-120b on Scaleway: 0.15 €/M in, 0.60 €/M out → $0.18 / $0.72.
    // The token counts are the ones a live call actually returned.
    const cost = scalewayAdapter.estimateCostUsd?.(
      request({ inputPerMTok: 0.18, outputPerMTok: 0.72 }),
      { inputTokens: 74, outputTokens: 52 },
    );
    expect(cost).toBeCloseTo((74 * 0.18 + 52 * 0.72) / 1e6, 12);
  });

  test("no stored rate yields NO number rather than zero", () => {
    // Zero is the failure this whole mechanism exists to prevent: it reads as
    // "this model is free" on a cost dashboard.
    expect(
      scalewayAdapter.estimateCostUsd?.(request(), {
        inputTokens: 74,
        outputTokens: 52,
      }),
    ).toBeUndefined();
  });

  test("a call that consumed nothing is not priced at zero either", () => {
    expect(
      scalewayAdapter.estimateCostUsd?.(
        request({ inputPerMTok: 0.18, outputPerMTok: 0.72 }),
        {},
      ),
    ).toBeUndefined();
  });

  test("every input token is priced at list, because the cache split is invisible", () => {
    // Scaleway caches automatically and bills reads lower for the models that
    // have a cache rate, but returns `prompt_tokens_details: null` — so the
    // split cannot be observed and the figure is an UPPER BOUND. Passing a
    // cached count must not silently discount it.
    const withCache = scalewayAdapter.estimateCostUsd?.(
      request({ inputPerMTok: 0.18, outputPerMTok: 0.72 }),
      { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100 },
    );
    const withoutCache = scalewayAdapter.estimateCostUsd?.(
      request({ inputPerMTok: 0.18, outputPerMTok: 0.72 }),
      { inputTokens: 1000, outputTokens: 100 },
    );
    expect(withCache).toBe(withoutCache);
  });

  test("a transport that prices its own calls has no estimator at all", () => {
    // The estimator is the exception, not a hook every adapter fills in. Both
    // aggregators report a real figure, so neither may offer a computed one —
    // that is what keeps a derived number from ever shadowing a measured one.
    expect("estimateCostUsd" in gatewayAdapter).toBe(false);
    expect("estimateCostUsd" in createOpenRouterAdapter(() => undefined)).toBe(
      false,
    );
    expect("estimateCostUsd" in scalewayAdapter).toBe(true);
  });
});
