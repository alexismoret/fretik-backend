import { describe, expect, test } from "bun:test";
import type { CapabilitySignals } from "../../src/model-registry/eligibility";
import {
  capabilitySignals,
  eligibleFunctions,
  functionEligibility,
  signalsFromLive,
} from "../../src/model-registry/eligibility";
import { MODEL_FUNCTION_KEYS } from "../../src/model-registry/functions";
import { blendedPricePerMTok } from "../../src/model-registry/measures";
import type {
  EndpointStat,
  LiveModelState,
} from "../../src/model-registry/types";

/**
 * The rules that decide what a model is good for.
 *
 * The fixtures are REAL rows measured on 2026-08-30, not invented ones, because
 * the defect this replaces was invisible in the abstract and obvious in the
 * data: three models the price bands graded wrong are pinned here so the
 * regression cannot come back quietly.
 */

/** Clears every floor by default, so each test states only what it is about. */
const signals = (over: CapabilitySignals = {}): CapabilitySignals => ({
  intelligence: 40,
  contextTokens: 300_000,
  tokensPerSecond: 60,
  ttftP50Ms: 900,
  blendedPricePerMTok: 1,
  tools: true,
  ...over,
});

describe("the three price-band mis-gradings", () => {
  test("zai-glm-5-3: the best index we track was shut out of the assistant", () => {
    // Measured: intelligence 59.5 (the fleet's highest), 997 952 usable tokens,
    // 129 tok/s, blended $1.49. The price bands put a mid-priced model in the
    // middle band, so the strongest model we had was not offered for chat.
    expect(
      eligibleFunctions(
        signals({
          intelligence: 59.5,
          contextTokens: 997_952,
          tokensPerSecond: 129,
          blendedPricePerMTok: 1.49,
        }),
      ),
    ).toContain("assistant");
  });

  test("zai-glm-5-3-flash: cheap is not the same as weak", () => {
    // 57.5 intelligence, 997 952 tokens, $0.16 blended — graded "utility"
    // purely because it is cheap, which said nothing about what it can do.
    const fns = eligibleFunctions(
      signals({
        intelligence: 57.5,
        contextTokens: 997_952,
        tokensPerSecond: 71,
        blendedPricePerMTok: 0.16,
      }),
    );
    expect(fns).toContain("documents");
    expect(fns).toContain("assistant");
  });

  test("kimi-k2-7-code-highspeed: expensive is not the same as capable", () => {
    // No Artificial Analysis record at all, $3.425 blended. The price bands
    // made it a flagship on the strength of the bill. `unknown` never grants.
    expect(
      eligibleFunctions(
        signals({ intelligence: undefined, blendedPricePerMTok: 3.425 }),
      ),
    ).not.toContain("assistant");
    expect(
      functionEligibility("assistant", signals({ intelligence: undefined })),
    ).toMatchObject({ verdict: "unknown" });
  });
});

describe("missing data is unknown, never false", () => {
  test("a measured failure outranks an unanswerable rule", () => {
    // Context is measured and too small; intelligence is missing. The report
    // must lead with the decision, not with the gap.
    const result = functionEligibility(
      "pages",
      signals({ intelligence: undefined, contextTokens: 8_000 }),
    );
    expect(result.verdict).toBe("ineligible");
    expect(result.failed).toEqual(["contextTokens ≥ 200000"]);
    expect(result.unknown).toEqual(["intelligence ≥ 45"]);
  });

  test("an unknown alternative keeps an `any` rule open rather than failing it", () => {
    // Too slow to pass on speed, no price to judge on: "cheap or fast" is
    // unanswered, not answered no.
    expect(
      functionEligibility(
        "quick-tasks",
        signals({ tokensPerSecond: 10, blendedPricePerMTok: undefined }),
      ).verdict,
    ).toBe("unknown");
    // Both alternatives measured and both failing IS a decision.
    expect(
      functionEligibility(
        "quick-tasks",
        signals({ tokensPerSecond: 10, blendedPricePerMTok: 5 }),
      ).verdict,
    ).toBe("ineligible");
  });

  test("an empty pool cannot answer whether the model calls tools", () => {
    const derived = capabilitySignals({
      aa: null,
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      contextTokens: 300_000,
      endpoints: [],
    });
    expect(derived.tools).toBeUndefined();
    expect(functionEligibility("documents", derived).verdict).not.toBe(
      "ineligible",
    );
  });
});

describe("threshold edges", () => {
  test("`atLeast` includes the boundary and `below` excludes it", () => {
    expect(eligibleFunctions(signals({ intelligence: 45 }))).toContain(
      "assistant",
    );
    expect(eligibleFunctions(signals({ intelligence: 44.9 }))).not.toContain(
      "assistant",
    );
    // The quick-tasks price rule is `below` the market p25 ($0.13).
    expect(
      functionEligibility(
        "quick-tasks",
        signals({ tokensPerSecond: 10, blendedPricePerMTok: 0.13 }),
      ).verdict,
    ).toBe("ineligible");
    expect(
      functionEligibility(
        "quick-tasks",
        signals({ tokensPerSecond: 10, blendedPricePerMTok: 0.129 }),
      ).verdict,
    ).toBe("eligible");
  });

  test("recall reads first-token latency as a CEILING", () => {
    expect(
      functionEligibility("recall", signals({ ttftP50Ms: 2000 })).verdict,
    ).toBe("eligible");
    expect(
      functionEligibility("recall", signals({ ttftP50Ms: 2001 })).verdict,
    ).toBe("ineligible");
  });
});

describe("`unmet` — the failures, structured for a client to re-word", () => {
  test("mirrors `failed` one for one on plain `all` rules", () => {
    const result = functionEligibility(
      "assistant",
      signals({ intelligence: 20, contextTokens: 100_000 }),
    );
    expect(result.verdict).toBe("ineligible");
    expect(result.unmet).toHaveLength(result.failed.length);
    expect(result.unmet.map((requirement) => requirement.rules)).toEqual([
      [{ kind: "atLeast", signal: "intelligence", value: 45 }],
      [{ kind: "atLeast", signal: "contextTokens", value: 256_000 }],
    ]);
  });

  test("a failed `any` group is ONE requirement holding every alternative", () => {
    // "fast OR cheap", satisfied neither way. Reported as two requirements it
    // would tell a reader they must fix both, when either one would do.
    const result = functionEligibility(
      "quick-tasks",
      signals({ tokensPerSecond: 10, blendedPricePerMTok: 5 }),
    );
    expect(result.verdict).toBe("ineligible");
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.rules).toHaveLength(2);
  });

  test("carries a hard capability gate as itself, not as a number", () => {
    const result = functionEligibility(
      "vision",
      signals({ inputModalities: [] }),
    );
    expect(result.unmet).toEqual([
      { rules: [{ kind: "modality", modality: "image" }] },
    ]);
  });

  test("stays empty on `unknown` — a gap is not a failure", () => {
    // The asymmetry the whole engine turns on: nobody graded this model, so
    // there is nothing to tell the reader to fix.
    const result = functionEligibility("assistant", {
      contextTokens: 300_000,
      tools: true,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.unmet).toEqual([]);
  });

  test("stays empty when the model passes", () => {
    // `documents`, not `assistant`: the shared fixture sits at intelligence 40,
    // under the flagship floor of 45 and over the workhorse floor of 30.
    expect(functionEligibility("documents", signals()).verdict).toBe(
      "eligible",
    );
    expect(functionEligibility("documents", signals()).unmet).toEqual([]);
  });
});

describe("every model the fleet is bound to is eligible for its own function", () => {
  /**
   * The invariant that keeps a rule honest: a threshold that excludes the
   * default it was written around is a threshold that is wrong. Every figure
   * below was read off `model_live_state` on 2026-08-30.
   */
  const FLEET = [
    {
      key: "deepseek-v4-flash",
      fns: ["assistant", "documents", "memory"],
      signals: signals({
        intelligence: 51.8,
        contextTokens: 997_952,
        tokensPerSecond: 50,
        ttftP50Ms: 678,
        blendedPricePerMTok: 0.062,
      }),
    },
    {
      key: "gpt-oss-120b",
      fns: ["memory", "recall", "quick-tasks"],
      signals: signals({
        intelligence: 24.1,
        contextTokens: 126_024,
        tokensPerSecond: 121,
        ttftP50Ms: 380,
        blendedPricePerMTok: 0.099,
      }),
    },
    {
      key: "gpt-oss-20b",
      fns: ["quick-tasks"],
      signals: signals({
        intelligence: 15.2,
        contextTokens: 129_024,
        tokensPerSecond: 67,
        ttftP50Ms: 408,
        blendedPricePerMTok: 0.038,
      }),
    },
    {
      key: "gemini-3.7-flash",
      fns: ["pages", "assistant", "documents"],
      signals: signals({
        intelligence: 56,
        contextTokens: 1_046_528,
        tokensPerSecond: 81,
        ttftP50Ms: 2218,
        blendedPricePerMTok: 0.349,
      }),
    },
    {
      key: "gemini-3.5-flash-lite",
      fns: ["vision"],
      signals: signals({
        intelligence: 37.4,
        contextTokens: 1_046_528,
        tokensPerSecond: 9,
        ttftP50Ms: 1092,
        blendedPricePerMTok: 0.187,
        inputModalities: ["text", "image", "file"],
      }),
    },
  ] as const;

  for (const model of FLEET) {
    for (const fn of model.fns) {
      test(`${model.key} is eligible for ${fn}`, () => {
        expect(functionEligibility(fn, model.signals)).toMatchObject({
          verdict: "eligible",
        });
      });
    }
  }

  test("deepseek-v4-flash clears the memory speed floor with room to spare", () => {
    // It measures exactly 50 tok/s. The plan's original floor WAS 50, so one
    // slow night would have made the fleet's own default ineligible for three
    // of the four memory roles it serves. The floor is 30.
    expect(
      functionEligibility("memory", signals({ tokensPerSecond: 40 })).verdict,
    ).toBe("eligible");
  });

  test("vision refuses a model with no image modality, whatever else it has", () => {
    expect(
      functionEligibility(
        "vision",
        signals({ intelligence: 99, inputModalities: ["text"] }),
      ),
    ).toMatchObject({ verdict: "ineligible", failed: ["image input"] });
  });
});

describe("capabilitySignals", () => {
  const endpoint = (over: Partial<EndpointStat>): EndpointStat => ({
    provider: "groq",
    displayName: "Groq",
    wireNames: {},
    contextLength: 262_144,
    pricing: { inputPerMTok: 1, outputPerMTok: 4 },
    supportedParameters: ["tools"],
    ...over,
  });

  test("speed and latency are the pool MEDIAN, not its best member", () => {
    const derived = capabilitySignals({
      aa: null,
      pricing: { inputPerMTok: 1, outputPerMTok: 4 },
      contextTokens: 300_000,
      endpoints: [
        endpoint({ provider: "a", throughputP50: 10, latencyP50Ms: 3000 }),
        endpoint({ provider: "b", throughputP50: 60, latencyP50Ms: 900 }),
        endpoint({ provider: "c", throughputP50: 300, latencyP50Ms: 200 }),
      ],
    });
    expect(derived.tokensPerSecond).toBe(60);
    expect(derived.ttftP50Ms).toBe(900);
  });

  test("the blended price carries the cache rate", () => {
    const pricing = {
      inputPerMTok: 1,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.1,
    };
    const derived = capabilitySignals({
      aa: null,
      pricing,
      contextTokens: 300_000,
      endpoints: [endpoint({})],
    });
    expect(derived.blendedPricePerMTok).toBe(blendedPricePerMTok(pricing));
    // A model whose upstream discounts cache reads is genuinely cheaper for a
    // workload that is 97 % prompt, and the signal has to say so.
    expect(derived.blendedPricePerMTok).toBeLessThan(
      blendedPricePerMTok({ inputPerMTok: 1, outputPerMTok: 4 }),
    );
  });

  test("an unpriced row reports no price rather than a free one", () => {
    expect(
      capabilitySignals({
        aa: null,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        contextTokens: 300_000,
        endpoints: [endpoint({})],
      }).blendedPricePerMTok,
    ).toBeUndefined();
  });
});

describe("signalsFromLive", () => {
  const row = (over: Partial<LiveModelState>): LiveModelState => ({
    profileKey: "acme-1",
    status: "published",
    transport: "openrouter",
    enabled: true,
    disabledReason: null,
    modelIds: { openrouter: "acme/1" },
    providerPool: {},
    quarantinedProviders: [],
    poolWidened: false,
    lastResort: false,
    effectiveContextLength: 300_000,
    effectiveMaxOutput: null,
    pricing: { inputPerMTok: 1, outputPerMTok: 4 },
    creditMultiplier: null,
    health: "healthy",
    healthScore: 90,
    policyReport: null,
    endpointStats: [],
    aaMetrics: { intelligenceIndex: 50 },
    releasedAt: null,
    aaSlug: null,
    dynamicProfile: null,
    boundRoles: [],
    source: "sync",
    syncedAt: null,
    ...over,
  });

  test("a curated row declares no modalities here, so vision stays unanswered", () => {
    // The answer lives in the TypeScript profile, which this package cannot
    // see. Reporting `false` would make every curated model vision-ineligible.
    const derived = signalsFromLive(row({ dynamicProfile: null }));
    expect(derived.inputModalities).toBeUndefined();
    expect(functionEligibility("vision", derived).verdict).toBe("unknown");
  });

  test("a synthesised row carries the modalities the catalogues published", () => {
    const derived = signalsFromLive(
      row({
        dynamicProfile: {
          displayName: "Acme 1",
          family: "acme",
          contextLength: 300_000,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          supportedParameters: ["tools"],
          supportsReasoning: false,
          supportsTools: true,
          derivedFrom: { source: "openrouter", at: "2026-08-30T00:00:00.000Z" },
        },
      }),
    );
    expect(derived.inputModalities).toEqual(["text", "image"]);
  });
});

describe("eligibleFunctions", () => {
  test("only `eligible` grants, and the list is stable in key order", () => {
    const all = eligibleFunctions(
      signals({
        intelligence: 60,
        contextTokens: 1_000_000,
        tokensPerSecond: 150,
        ttftP50Ms: 300,
        blendedPricePerMTok: 0.05,
        inputModalities: ["text", "image"],
      }),
    );
    expect(all).toEqual([...MODEL_FUNCTION_KEYS]);
  });

  test("a model nobody graded earns nothing", () => {
    expect(
      eligibleFunctions({ contextTokens: 1_000_000, tools: true }),
    ).toEqual([]);
  });
});
