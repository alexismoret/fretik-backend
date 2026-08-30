import { describe, expect, test } from "bun:test";
import type { MergedCatalogueEntry } from "../../src/model-registry/catalogue";
import { blendedPricePerMTok } from "../../src/model-registry/measures";
import type {
  EndpointStat,
  PricingSnapshot,
} from "../../src/model-registry/types";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MIN_CREDIT_MULTIPLIER,
  PRICE_JUMP_THRESHOLD,
  REFERENCE_BLENDED_COST_PER_MTOK,
  buildAllowedPool,
  computeCreditMultiplier,
  computeEffectiveContext,
  computePoolPricing,
  deriveDynamicProfile,
  detectPriceJump,
  mergeEndpointStats,
} from "../../src/services/model-registry/sync/compute";

/**
 * The sync's decisions, with no clock, database or network in sight.
 *
 * Fixtures are shaped like the real payloads (per-MTok prices already
 * converted, the same provider spellings the two APIs actually use: gateway
 * `togetherai` vs OpenRouter `Together`). What is asserted here is what the
 * write guards, the pool and the credit multiplier are worth — every one of
 * these used to be a number in a person's head.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"],
  ...over,
  // The easy case, where identity and filter token coincide. Cases about the
  // hosts where they DIVERGE set this explicitly.
  wireNames: over.wireNames ?? {
    openrouter: over.provider,
    gateway: over.provider,
  },
});

const price = (input: number, output: number): PricingSnapshot => ({
  inputPerMTok: input,
  outputPerMTok: output,
});

describe("mergeEndpointStats", () => {
  test("enrichment fills quantization, the one column only OpenRouter reports", () => {
    const merged = mergeEndpointStats(
      [endpoint({ provider: "deepinfra" })],
      [endpoint({ provider: "deepinfra", quantization: "fp4" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.quantization).toBe("fp4");
  });

  test("enrichment fills the zero-retention stance, the column only the gateway reports", () => {
    // The mirror image of the quantization case, and the two together are why
    // the enrichment fetch earns its round trip: each source knows exactly one
    // thing the other cannot see. Measured 2026-08-29 — a model routed through
    // OpenRouter had no `hasZdr` on any endpoint until the gateway filled it.
    const merged = mergeEndpointStats(
      [endpoint({ provider: "baseten", quantization: "fp8" })],
      [endpoint({ provider: "baseten", hasZdr: true })],
    );
    expect(merged[0]?.hasZdr).toBe(true);
    expect(merged[0]?.quantization).toBe("fp8");
  });

  test("a declared `false` stance survives an enrichment that says nothing", () => {
    const merged = mergeEndpointStats(
      [endpoint({ provider: "wafer", hasZdr: false })],
      [endpoint({ provider: "wafer" })],
    );
    expect(merged[0]?.hasZdr).toBe(false);
  });

  test("enrichment never overrides a field the primary reports", () => {
    const merged = mergeEndpointStats(
      [
        endpoint({
          provider: "novita",
          contextLength: 131_072,
          pricing: { inputPerMTok: 0.09, outputPerMTok: 0.58 },
          quantization: "bf16",
          throughputP50: 49.5,
          uptime1d: 100,
          maxCompletionTokens: 32_768,
        }),
      ],
      [
        endpoint({
          provider: "novita",
          contextLength: 40_960,
          pricing: { inputPerMTok: 99, outputPerMTok: 99 },
          quantization: "fp4",
          throughputP50: 8,
          uptime1d: 12,
          maxCompletionTokens: 8_192,
        }),
      ],
    );
    expect(merged[0]).toMatchObject({
      contextLength: 131_072,
      quantization: "bf16",
      throughputP50: 49.5,
      uptime1d: 100,
      maxCompletionTokens: 32_768,
    });
    expect(merged[0]?.pricing.inputPerMTok).toBe(0.09);
  });

  test("cache rates fill gaps per field without touching the base prices", () => {
    const merged = mergeEndpointStats(
      [
        endpoint({
          provider: "deepinfra",
          pricing: { inputPerMTok: 0.25, outputPerMTok: 0.95 },
        }),
      ],
      [
        endpoint({
          provider: "deepinfra",
          pricing: {
            inputPerMTok: 9,
            outputPerMTok: 9,
            cacheReadPerMTok: 0.13,
          },
        }),
      ],
    );
    expect(merged[0]?.pricing).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 0.95,
      cacheReadPerMTok: 0.13,
    });
  });

  test("providers present only in the enrichment source are dropped", () => {
    const merged = mergeEndpointStats(
      [endpoint({ provider: "deepinfra" })],
      [endpoint({ provider: "cerebras" }), endpoint({ provider: "groq" })],
    );
    expect(merged.map((e) => e.provider)).toEqual(["deepinfra"]);
  });

  test("the join folds the two sources' spellings of one company", () => {
    // Gateway says `togetherai`, OpenRouter says `Together`. A join that missed
    // this would drop the enrichment silently instead of loudly.
    const merged = mergeEndpointStats(
      [endpoint({ provider: "togetherai", displayName: "togetherai" })],
      [
        {
          ...endpoint({ provider: "Together", displayName: "Together" }),
          quantization: "fp8",
        },
      ],
    );
    expect(merged[0]?.quantization).toBe("fp8");
  });

  test("primary order survives the merge", () => {
    const merged = mergeEndpointStats(
      [
        endpoint({ provider: "vertex" }),
        endpoint({ provider: "deepinfra" }),
        endpoint({ provider: "novita" }),
      ],
      [endpoint({ provider: "novita", quantization: "bf16" })],
    );
    expect(merged.map((e) => e.provider)).toEqual([
      "vertex",
      "deepinfra",
      "novita",
    ]);
  });
});

describe("buildAllowedPool", () => {
  const four = [
    endpoint({ provider: "deepinfra" }),
    endpoint({ provider: "novita" }),
    endpoint({ provider: "vertex" }),
    endpoint({ provider: "baseten" }),
  ];

  test("quarantine wins over every other rule and names its reason", () => {
    const pool = buildAllowedPool({
      declaredPool: { only: ["deepinfra", "novita"] },
      poolWidened: false,
      quarantined: ["deepinfra"],
      endpoints: four,
      requireTools: true,
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual(["novita"]);
    expect(pool.excluded).toContainEqual({
      provider: "deepinfra",
      reason: "quarantined by the breaker",
    });
  });

  test("`only` narrows the pool and records everyone it dropped", () => {
    const pool = buildAllowedPool({
      declaredPool: { only: ["deepinfra"] },
      poolWidened: false,
      quarantined: [],
      endpoints: four,
      requireTools: true,
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual(["deepinfra"]);
    expect(pool.excluded).toHaveLength(3);
    expect(pool.excluded.every((x) => x.reason.includes("`only`"))).toBe(true);
  });

  test("a widened pool ignores `only` but still honours the quarantine", () => {
    const pool = buildAllowedPool({
      declaredPool: { only: ["deepinfra"] },
      poolWidened: true,
      quarantined: ["novita"],
      endpoints: four,
      requireTools: true,
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual([
      "deepinfra",
      "vertex",
      "baseten",
    ]);
  });

  test("`ignore` excludes, and `only` is checked first", () => {
    const pool = buildAllowedPool({
      declaredPool: { ignore: ["vertex"] },
      poolWidened: false,
      quarantined: [],
      endpoints: four,
      requireTools: true,
    });
    expect(pool.endpoints.map((e) => e.provider)).not.toContain("vertex");
    expect(pool.excluded).toContainEqual({
      provider: "vertex",
      reason: "listed in the declared `ignore`",
    });
  });

  test("an empty `only` reads as no declaration, not as `allow nothing`", () => {
    const pool = buildAllowedPool({
      declaredPool: { only: [] },
      poolWidened: false,
      quarantined: [],
      endpoints: four,
      requireTools: true,
    });
    expect(pool.endpoints).toHaveLength(4);
  });

  test("an endpoint that does not advertise `tools` is dropped", () => {
    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints: [
        endpoint({ provider: "deepinfra" }),
        endpoint({
          provider: "novita",
          supportedParameters: ["max_tokens", "temperature"],
        }),
      ],
      requireTools: true,
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual(["deepinfra"]);
    expect(pool.excluded).toContainEqual({
      provider: "novita",
      reason: "does not advertise `tools`",
    });
  });

  test("requireTools false keeps an endpoint without `tools`", () => {
    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints: [
        endpoint({ provider: "novita", supportedParameters: ["max_tokens"] }),
      ],
      requireTools: false,
    });
    expect(pool.endpoints).toHaveLength(1);
  });

  test("the quantization floor excludes a reported precision below it", () => {
    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints: [
        endpoint({ provider: "deepinfra", quantization: "fp4" }),
        endpoint({ provider: "novita", quantization: "bf16" }),
      ],
      requireTools: true,
      quantizationFloor: ["bf16", "fp16", "unknown"],
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual(["novita"]);
    expect(pool.excluded[0]?.reason).toContain("fp4");
  });

  test("an unreported quantization never excludes — the gateway reports none", () => {
    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints: [
        endpoint({ provider: "deepinfra" }),
        endpoint({ provider: "vertex" }),
      ],
      requireTools: true,
      quantizationFloor: ["bf16"],
    });
    expect(pool.endpoints).toHaveLength(2);
    expect(pool.excluded).toEqual([]);
  });

  test("OpenRouter's literal `unknown` is a value the floor can accept", () => {
    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints: [endpoint({ provider: "alibaba", quantization: "unknown" })],
      requireTools: true,
      quantizationFloor: ["bf16", "fp16", "unknown"],
    });
    expect(pool.endpoints).toHaveLength(1);
  });

  test("each endpoint is reported under the FIRST rule that removed it", () => {
    const pool = buildAllowedPool({
      declaredPool: { only: ["novita"], ignore: ["deepinfra"] },
      poolWidened: false,
      quarantined: ["deepinfra"],
      endpoints: [endpoint({ provider: "deepinfra" })],
      requireTools: true,
    });
    expect(pool.excluded).toEqual([
      { provider: "deepinfra", reason: "quarantined by the breaker" },
    ]);
  });
});

describe("computeEffectiveContext", () => {
  test("the smallest endpoint decides, minus the safety margin", () => {
    const result = computeEffectiveContext([
      endpoint({ provider: "vertex", contextLength: 262_144 }),
      endpoint({ provider: "novita", contextLength: 131_072 }),
      endpoint({ provider: "deepinfra", contextLength: 40_960 }),
    ]);
    expect(result.contextLength).toBe(40_960 - CONTEXT_SAFETY_MARGIN_TOKENS);
  });

  test("never negative when the margin exceeds the smallest context", () => {
    const result = computeEffectiveContext(
      [endpoint({ provider: "novita", contextLength: 1_000 })],
      2_048,
    );
    expect(result.contextLength).toBe(0);
  });

  test("an empty pool has no context to budget against", () => {
    expect(computeEffectiveContext([])).toEqual({
      contextLength: 0,
      maxOutput: null,
    });
  });

  test("maxOutput is the smallest reported cap", () => {
    const result = computeEffectiveContext([
      endpoint({ provider: "novita", maxCompletionTokens: 32_768 }),
      endpoint({ provider: "deepinfra", maxCompletionTokens: 16_384 }),
    ]);
    expect(result.maxOutput).toBe(16_384);
  });

  test("maxOutput is null when nobody declares one", () => {
    const result = computeEffectiveContext([
      endpoint({ provider: "novita" }),
      endpoint({ provider: "deepinfra", maxCompletionTokens: undefined }),
    ]);
    expect(result.maxOutput).toBeNull();
  });

  test("endpoints that do declare a cap still set it when others do not", () => {
    const result = computeEffectiveContext([
      endpoint({ provider: "novita" }),
      endpoint({ provider: "deepinfra", maxCompletionTokens: 8_192 }),
    ]);
    expect(result.maxOutput).toBe(8_192);
  });
});

describe("computePoolPricing", () => {
  const priced = (
    provider: string,
    input: number,
    output: number,
  ): EndpointStat => endpoint({ provider, pricing: price(input, output) });

  test("odd counts take the middle endpoint, not the cheapest", () => {
    const pricing = computePoolPricing([
      priced("a", 0.09, 0.1),
      priced("b", 0.22, 0.88),
      priced("c", 0.5, 2),
    ]);
    expect(pricing).toEqual({ inputPerMTok: 0.22, outputPerMTok: 0.88 });
  });

  test("even counts average the two middle values", () => {
    const pricing = computePoolPricing([
      priced("a", 0.1, 1),
      priced("b", 0.2, 2),
      priced("c", 0.4, 4),
      priced("d", 0.8, 8),
    ]);
    expect(pricing).toEqual({
      inputPerMTok: 0.3,
      outputPerMTok: 3,
    });
  });

  test("one outlier does not move the median the way it moves a mean", () => {
    const pricing = computePoolPricing([
      priced("a", 1, 4),
      priced("b", 1, 4),
      priced("c", 30, 120),
    ]);
    expect(pricing.inputPerMTok).toBe(1);
  });

  test("cache fields are omitted when no endpoint quotes one", () => {
    const pricing = computePoolPricing([priced("a", 1, 4)]);
    expect(pricing.cacheReadPerMTok).toBeUndefined();
    expect(Object.keys(pricing).sort()).toEqual([
      "inputPerMTok",
      "outputPerMTok",
    ]);
  });

  test("cache fields are the median of the endpoints that DO quote one", () => {
    const pricing = computePoolPricing([
      endpoint({
        provider: "a",
        pricing: { ...price(1, 4), cacheReadPerMTok: 0.1 },
      }),
      endpoint({ provider: "b", pricing: price(1, 4) }),
      endpoint({
        provider: "c",
        pricing: { ...price(1, 4), cacheReadPerMTok: 0.3 },
      }),
    ]);
    expect(pricing.cacheReadPerMTok).toBe(0.2);
  });

  test("an empty pool prices at zero — which the write guard refuses", () => {
    expect(computePoolPricing([])).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
  });
});

describe("computeCreditMultiplier", () => {
  test("the reference blended cost is 1.0x by construction", () => {
    expect(
      computeCreditMultiplier(
        price(REFERENCE_BLENDED_COST_PER_MTOK, REFERENCE_BLENDED_COST_PER_MTOK),
      ),
    ).toBe(1);
  });

  test("the prompt column all but IS the blend", () => {
    // 0.97 * 2 + 0.03 * 10 = 2.24, with no cache rate to apply.
    expect(blendedPricePerMTok(price(2, 10))).toBeCloseTo(2.24, 10);
    expect(computeCreditMultiplier(price(2, 10))).toBeCloseTo(2.24 / 0.35, 2);
  });

  test("two decimals, so a daily repricing does not renumber the fleet", () => {
    expect(computeCreditMultiplier(price(0.123_456, 0.789))).toBe(0.41);
  });

  test("floored — nothing bills at zero", () => {
    expect(computeCreditMultiplier(price(0, 0))).toBe(MIN_CREDIT_MULTIPLIER);
    expect(computeCreditMultiplier(price(0.01, 0.01))).toBe(
      MIN_CREDIT_MULTIPLIER,
    );
  });

  test("an explicit reference rescales the whole fleet at once", () => {
    expect(computeCreditMultiplier(price(4, 4), 2)).toBe(2);
  });
});

describe("deriveDynamicProfile", () => {
  const entry = (
    over: Partial<MergedCatalogueEntry>,
  ): MergedCatalogueEntry => ({
    id: "acme/model-1",
    name: "Model 1",
    description: "",
    owner: "acme",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["max_tokens", "tools"],
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    idsByTransport: { gateway: "acme/model-1" },
    ...over,
  });
  const at = new Date("2026-08-29T03:00:00.000Z");
  test("capabilities come from what the catalogues declare", () => {
    const profile = deriveDynamicProfile(
      entry({
        supportedParameters: ["tools", "reasoning"],
        inputModalities: ["text", "image", "file"],
      }),
      at,
    );
    expect(profile.supportsTools).toBe(true);
    expect(profile.supportsReasoning).toBe(true);
    expect(profile.inputModalities).toEqual(["text", "image", "file"]);
    expect(profile.outputModalities).toEqual(["text"]);
  });

  test("a name that promises capabilities the declarations do not is not believed", () => {
    const profile = deriveDynamicProfile(
      entry({
        id: "acme/model-1-vision-reasoning-tool-use",
        name: "Model 1 Vision Reasoning Tool Use",
        supportedParameters: [],
      }),
      at,
    );
    expect(profile.supportsTools).toBe(false);
    expect(profile.supportsReasoning).toBe(false);
    expect(profile.inputModalities).toEqual(["text"]);
  });

  test("a modality only one catalogue can express survives the merge", () => {
    // Audio input exists on exactly one of the three sources. Deriving it from
    // the gateway's two tags — the rule this replaced — could not express it at
    // all, so a model that accepts speech was recorded as text-only.
    expect(
      deriveDynamicProfile(entry({ inputModalities: ["text", "audio"] }), at)
        .inputModalities,
    ).toEqual(["text", "audio"]);
  });

  test("provenance names every transport that described the model", () => {
    expect(
      deriveDynamicProfile(
        entry({
          idsByTransport: { openrouter: "acme/m1", scaleway: "m1" },
        }),
        at,
      ).derivedFrom.source,
    ).toBe("openrouter+scaleway");
  });

  test("the catalogue facts are copied verbatim and stamped", () => {
    const profile = deriveDynamicProfile(
      entry({
        name: "Qwen3 235B A22B",
        owner: "alibaba",
        contextWindow: 262_144,
        maxTokens: 16_384,
        supportedParameters: ["max_tokens", "tools", "tool_choice"],
      }),
      at,
    );
    expect(profile).toMatchObject({
      displayName: "Qwen3 235B A22B",
      family: "alibaba",
      contextLength: 262_144,
      maxCompletionTokens: 16_384,
      supportedParameters: ["max_tokens", "tools", "tool_choice"],
    });
    expect(profile.derivedFrom.at).toBe(at.toISOString());
  });

  test("a model the catalogue does not size gets 0, not a guess", () => {
    expect(
      deriveDynamicProfile(entry({ contextWindow: undefined }), at)
        .contextLength,
    ).toBe(0);
  });
});

describe("detectPriceJump", () => {
  test("no previous price is nothing to compare", () => {
    expect(detectPriceJump(null, price(1, 4))).toBeNull();
  });

  test("a zero baseline yields no signal rather than infinity", () => {
    expect(detectPriceJump(price(0, 0), price(1, 4))).toBeNull();
  });

  test("exactly at the threshold fires", () => {
    expect(detectPriceJump(price(1, 1), price(1.5, 1.5))).toBeCloseTo(
      PRICE_JUMP_THRESHOLD,
      10,
    );
  });

  test("just under the threshold stays quiet", () => {
    expect(detectPriceJump(price(1, 1), price(1.49, 1.49))).toBeNull();
  });

  test("a halving is reported too, signed", () => {
    const change = detectPriceJump(price(2, 2), price(1, 1));
    expect(change).toBeCloseTo(-0.5, 10);
  });

  test("an unchanged price is silent", () => {
    expect(detectPriceJump(price(0.22, 0.88), price(0.22, 0.88))).toBeNull();
  });

  test("the blend is what moves, not either price alone", () => {
    // Input doubles, output halves: 0.97*2 + 0.03*2 = 2 → 0.97*4 + 0.03*1 = 3.91.
    const change = detectPriceJump(price(2, 2), price(4, 1));
    expect(change).toBeCloseTo(0.955, 10);
  });

  test("a cache rate is part of the price, so a cache repricing is a jump", () => {
    // Same list prices; the upstream triples what it charges for a cache read.
    // At a 75 % hit rate on a 97 % prompt mix that is a real repricing, and the
    // list-price blend this replaced could not see it at all.
    const before = { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1 };
    const after = { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.9 };
    expect(detectPriceJump(before, after)).not.toBeNull();
  });
});
