import { describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * The memo's eviction order, observed through the tokeniser itself: a miss
 * calls `encode`, a hit does not. Counting calls rather than timing them is
 * what makes this deterministic — the timing test in `token-estimate.test.ts`
 * proves a hit is cheap, not which entry survives.
 *
 * The double delegates to the real encoder, so any other file that meets it in
 * the same run still gets real counts.
 */

const actual = await import("gpt-tokenizer/encoding/o200k_base");
const realEncode = actual.encode;
let encodeCalls = 0;
await mockModule("gpt-tokenizer/encoding/o200k_base", {
  encode: (text: string) => {
    encodeCalls += 1;
    return realEncode(text);
  },
});

const { countCachedTokens, TOKEN_CACHE_MAX_ENTRIES } =
  await import("../../src/lib/token-estimate");

describe("countCachedTokens eviction", () => {
  // Fails under insertion-order eviction: the full cache drops its OLDEST
  // insert, and the row read on every step is exactly that.
  test("a hit keeps an entry alive through a full cache of newer ones", () => {
    const hot = "the row an open conversation reads on every step";
    countCachedTokens(hot);
    for (let i = 1; i < TOKEN_CACHE_MAX_ENTRIES; i++) {
      countCachedTokens(`filler ${i.toString()}`);
    }
    countCachedTokens(hot);
    countCachedTokens("one insert past the bound");

    const before = encodeCalls;
    countCachedTokens(hot);
    expect(encodeCalls).toBe(before);
  });
});
