import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CANDIDATE_POLICY,
  PROMOTION_PRICE_CAPS,
  PUBLISHED_POLICY,
  evaluatePolicy,
  promotionEnablement,
} from "../../src/model-registry/policy";
import type { EndpointStat } from "../../src/model-registry/types";

/**
 * Price stopped being a question about a model's FITNESS and became a question
 * about our BUDGET (2026-08-30).
 *
 * The two were tangled: discovery refused any model over $2/$8, so an expensive
 * model was not merely unpaid-for, it was invisible — and once teams spend their
 * own credits, that is the catalogue hiding an option they are entitled to
 * choose. Splitting them means capability decides what is DISCOVERED and price
 * decides what is PAID FOR, re-asked every night rather than once.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 200_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

describe("promotionEnablement", () => {
  test("both caps must hold, and equality passes", () => {
    // A cheap prompt does not pay for an expensive completion, and our turns are
    // heavy on both. A cap is a limit, not an exclusive bound.
    expect(
      promotionEnablement({
        inputPerMTok: PROMOTION_PRICE_CAPS.inputPerMTok,
        outputPerMTok: PROMOTION_PRICE_CAPS.outputPerMTok,
      }),
    ).toEqual({ enabled: true });
  });

  test("input alone over the cap disables", () => {
    expect(
      promotionEnablement({ inputPerMTok: 2.01, outputPerMTok: 1 }),
    ).toEqual({ enabled: false, disabledReason: "cost" });
  });

  test("output alone over the cap disables", () => {
    expect(
      promotionEnablement({ inputPerMTok: 0.1, outputPerMTok: 8.01 }),
    ).toEqual({ enabled: false, disabledReason: "cost" });
  });

  test("a free model is within budget", () => {
    expect(promotionEnablement({ inputPerMTok: 0, outputPerMTok: 0 })).toEqual({
      enabled: true,
    });
  });
});

describe("discovery no longer grades on price", () => {
  test("the candidate policy sets no price ceiling at all", () => {
    // Asserted on the policy rather than on a report, because the absence is
    // the decision: a ceiling reintroduced here would make expensive models
    // undiscoverable again, which is the state this replaced.
    expect(DEFAULT_CANDIDATE_POLICY.maxPricePerMTok).toBeUndefined();
  });

  test("an expensive but capable model passes discovery", () => {
    // $6/$24 — three times the budget, and previously rejected outright.
    const report = evaluatePolicy(
      DEFAULT_CANDIDATE_POLICY,
      {
        endpoints: [
          endpoint({
            provider: "dear",
            pricing: { inputPerMTok: 6, outputPerMTok: 24 },
            hasZdr: true,
            throughputP50: 120,
            uptime1d: 99.5,
            maxCompletionTokens: 16_000,
            supportsImplicitCaching: true,
          }),
        ],
        excludedProviders: [],
        requiresTools: true,
        aa: { intelligenceIndex: 55 },
      },
      new Date(),
    );
    expect(report.hardFailures).toBe(0);
    expect(report.rules.map((r) => r.rule)).not.toContain(
      "price-input-ceiling",
    );
    // ...and the budget still says we would not pay for it.
    expect(
      promotionEnablement({ inputPerMTok: 6, outputPerMTok: 24 }).enabled,
    ).toBe(false);
  });

  test("the published policy KEEPS its runaway-price guard", () => {
    // A different job: it catches a model whose price ran away by an order of
    // magnitude, which is a fault rather than a budget choice.
    expect(PUBLISHED_POLICY.maxPricePerMTok).toEqual({ input: 10, output: 40 });
  });

  test("the discovery throughput floor is 50", () => {
    // Lowered from 60 on 2026-08-30: the 50-60 band held four real candidates
    // no other rule objected to.
    expect(DEFAULT_CANDIDATE_POLICY.minTpsP50).toBe(50);
  });
});

describe("the tool-choice rule", () => {
  const graded = (endpoints: EndpointStat[]) =>
    evaluatePolicy(
      PUBLISHED_POLICY,
      { endpoints, excludedProviders: [], requiresTools: true },
      new Date(),
    ).rules.find((r) => r.rule === "tool-choice");

  test("is absent when NO endpoint reports the field", () => {
    // Silence is not a verdict. Only one source publishes this, so grading a
    // pool that never answered would fail every gateway-only model for a
    // question nobody asked it.
    expect(
      graded([endpoint({ provider: "quiet", hasZdr: true })]),
    ).toBeUndefined();
  });

  test("fails SOFTLY when a reporting pool cannot be forced", () => {
    // AkashML's real shape: it takes tool definitions but only `auto`. Forced
    // extraction there does not error — it answers in prose, and the failure
    // surfaces as a parse error blamed on the model.
    const result = graded([
      endpoint({
        provider: "akashml",
        hasZdr: true,
        supportsToolChoice: ["auto"],
      }),
    ]);
    expect(result?.passed).toBe(false);
    expect(result?.severity).toBe("soft");
  });

  test("passes when at least one reporting endpoint accepts `required`", () => {
    const result = graded([
      endpoint({
        provider: "auto-only",
        hasZdr: true,
        supportsToolChoice: ["auto"],
      }),
      endpoint({
        provider: "forceable",
        hasZdr: true,
        supportsToolChoice: ["auto", "required"],
      }),
    ]);
    expect(result?.passed).toBe(true);
    expect(result?.detail).toContain("1 of 2");
  });

  test("never turns a soft rule into a publication blocker", () => {
    const report = evaluatePolicy(
      PUBLISHED_POLICY,
      {
        endpoints: [
          endpoint({
            provider: "akashml",
            hasZdr: true,
            supportsToolChoice: ["auto"],
            throughputP50: 200,
            uptime1d: 99,
          }),
        ],
        excludedProviders: [],
        requiresTools: true,
      },
      new Date(),
    );
    expect(report.hardFailures).toBe(0);
    expect(report.passed).toBe(true);
  });
});
