import { describe, expect, test } from "bun:test";
import {
  blendedPricePerMTok,
  cacheShape,
} from "../../src/model-registry/measures";

/**
 * How a vendor charges for its prompt cache, read off the prices.
 *
 * Every case below is a REAL quote from the OpenRouter catalogue on 2026-08-30,
 * kept as data rather than as a synthetic ratio, because the whole claim this
 * function rests on is that the four shapes separate cleanly in the market and
 * not merely in the abstract. If a vendor starts quoting a write at 1.05× the
 * input, that claim weakens and these numbers are where it will show.
 *
 * The hand-written `cache.strategy` this replaced disagreed with the prices on
 * 5 of 22 curated profiles, and the prices were right every time.
 */

describe("cacheShape", () => {
  test("a write ABOVE the input price is a premium (Anthropic, OpenAI)", () => {
    // claude-opus-5 via Bedrock: prompt 5.00, read 0.50, write 6.25 → 1.25×.
    expect(
      cacheShape({
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      }),
    ).toBe("write-premium");

    // gpt-5.6-luna via OpenAI: prompt 0.10, read 0.01, write 0.125 → 1.25×.
    // Curation called this `implicit`, which is true of the MECHANISM and says
    // nothing about the bill — the reason the field was split.
    expect(
      cacheShape({
        inputPerMTok: 0.1,
        outputPerMTok: 1.2,
        cacheReadPerMTok: 0.01,
        cacheWritePerMTok: 0.125,
      }),
    ).toBe("write-premium");
  });

  test("a write BELOW the input price is a storage rate, not a write (Google)", () => {
    // gemini-3.7-flash: prompt 0.75, read 0.075, write 0.0417 → 0.056×. Billing
    // that as a per-token write would make Gemini look 18× cheaper than it is.
    expect(
      cacheShape({
        inputPerMTok: 0.75,
        outputPerMTok: 3,
        cacheReadPerMTok: 0.075,
        cacheWritePerMTok: 0.041_666,
      }),
    ).toBe("storage-rate");
  });

  test("a read discount with no write charge is free writes (DeepSeek, GLM)", () => {
    expect(
      cacheShape({
        inputPerMTok: 0.44,
        outputPerMTok: 1.32,
        cacheReadPerMTok: 0.088,
      }),
    ).toBe("free-writes");
  });

  test("gpt-oss DOES cache — the curated `none` was wrong", () => {
    // Groq: prompt 0.15, read 0.075. Fireworks: 0.07 / 0.035. Both a real 50 %
    // discount, on a profile recorded as having no cache at all.
    expect(
      cacheShape({
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
        cacheReadPerMTok: 0.075,
      }),
    ).toBe("free-writes");
  });

  test("a read quoted at FULL price is not a discount", () => {
    // CoreWeave prices gpt-oss-120b cache reads at exactly the input rate.
    // A "discount" of 1.0× must not read as caching, or the cost model credits
    // a saving that never happens.
    expect(
      cacheShape({
        inputPerMTok: 0.03,
        outputPerMTok: 0.17,
        cacheReadPerMTok: 0.03,
      }),
    ).toBe("none");
  });

  test("no published cache rate at all", () => {
    expect(cacheShape({ inputPerMTok: 1.5, outputPerMTok: 7.5 })).toBe("none");
  });
});

describe("blendedPricePerMTok reads the same shape", () => {
  test("a storage rate is ignored, a premium is billed", () => {
    const base = { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1 };
    // Identical except for the write: one below input (storage), one above
    // (premium). Only the premium may move the number.
    const storage = blendedPricePerMTok({
      ...base,
      cacheWritePerMTok: 0.05,
    });
    const noWrite = blendedPricePerMTok(base);
    const premium = blendedPricePerMTok({ ...base, cacheWritePerMTok: 1.25 });

    expect(storage).toBeCloseTo(noWrite, 10);
    expect(premium).toBeGreaterThan(noWrite);
  });

  test("a full-price cache read costs the same as no cache at all", () => {
    const withRead = blendedPricePerMTok({
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 2,
    });
    const without = blendedPricePerMTok({ inputPerMTok: 2, outputPerMTok: 8 });
    expect(withRead).toBeCloseTo(without, 10);
  });
});
