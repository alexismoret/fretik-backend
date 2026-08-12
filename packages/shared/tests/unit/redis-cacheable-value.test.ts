import { describe, expect, test } from "bun:test";
import { isCacheableValue } from "../../src/lib/redis";

/**
 * `selectOrCache` used a truthiness test on both sides, which meant `false`,
 * `0` and `""` were computed, returned, and never stored — a permanent cache
 * miss visible only as load. Widening it to "cache everything" would have been
 * the other bug: three of the current callers turn a nullish result into a 403
 * or a 404, and two return `null` after a failed registry fetch, so storing
 * nullish would pin a denial or an outage for the whole TTL.
 *
 * These assertions are the boundary itself. No Redis round-trip is involved —
 * the decision is a pure predicate, which is why it can be pinned at all.
 */

describe("isCacheableValue — falsy answers are still answers", () => {
  test("caches the falsy primitives", () => {
    expect(isCacheableValue(false)).toBe(true);
    expect(isCacheableValue(0)).toBe(true);
    expect(isCacheableValue("")).toBe(true);
  });

  test("caches ordinary values", () => {
    expect(isCacheableValue({ id: "x" })).toBe(true);
    expect(isCacheableValue([])).toBe(true);
    expect(isCacheableValue("value")).toBe(true);
  });
});

describe("isCacheableValue — a miss is not an answer", () => {
  test("refuses nullish, so a 403 / 404 / outage is never pinned for a TTL", () => {
    expect(isCacheableValue(null)).toBe(false);
    expect(isCacheableValue(undefined)).toBe(false);
  });

  test("`findFirst` returning nothing stays uncached", () => {
    // The exact shape every auth caller hands back on a miss.
    const missingMember: { role: string } | undefined = undefined;
    expect(isCacheableValue(missingMember)).toBe(false);
  });
});

describe("isCacheableValue — every stored value survives the round-trip", () => {
  test("JSON encoding is never the empty string, so the read side is safe", () => {
    // `selectOrCache` reads with `value !== null`; this is the property that
    // makes that correct — no cacheable value encodes to a falsy string.
    for (const value of [false, 0, "", [], {}, "x"]) {
      const encoded = JSON.stringify(value);
      expect(encoded.length).toBeGreaterThan(0);
    }
  });

  test("false and 0 round-trip to themselves, not to null", () => {
    expect(JSON.parse(JSON.stringify(false))).toBe(false);
    expect(JSON.parse(JSON.stringify(0))).toBe(0);
  });
});
