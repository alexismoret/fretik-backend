import { describe, expect, test } from "bun:test";
import {
  parseRetryAfter,
  retryAfterFromHeaders,
} from "../../src/lib/http/retry-after";

/**
 * The one number this parser must never get wrong is the SCALE.
 *
 * `Retry-After: 30` and `x-ratelimit-reset: 1789543210` are both integers with
 * no unit on them, and reading the second as the first sleeps for fifty-six
 * years — a background job that never comes back and an interactive call that
 * waits out its whole budget on every attempt. Every case below fixes a scale,
 * and the two around the epoch floor are the boundary the whole thing turns on.
 */

/** 2026-09-19T00:00:00Z, so the arithmetic below reads as arithmetic. */
const NOW = Date.parse("2026-09-19T00:00:00.000Z");

describe("the two shapes the RFC defines", () => {
  test("delta-seconds is seconds", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  test("an HTTP-date is an instant, and a past one is zero rather than negative", () => {
    expect(parseRetryAfter("Sat, 19 Sep 2026 00:00:45 GMT", NOW)).toBe(45_000);
    // A clock skewed the wrong way must not produce a negative sleep, which
    // every caller would read as "go now" only after doing arithmetic on it.
    expect(parseRetryAfter("Sat, 19 Sep 2026 00:00:00 GMT", NOW + 5_000)).toBe(
      0,
    );
  });
});

describe("the two shapes the RFC does not define and APIs send anyway", () => {
  test("epoch seconds are an instant, not a delta", () => {
    // The case that makes the floor load-bearing: read as a delta this is
    // 56 years.
    expect(parseRetryAfter(String(NOW / 1000 + 60), NOW)).toBe(60_000);
  });

  test("epoch milliseconds are the same instant, at the other scale", () => {
    expect(parseRetryAfter(String(NOW + 90_000), NOW)).toBe(90_000);
  });

  test("just below the floor is still a delta — the boundary, from both sides", () => {
    // 999 999 999 s ≈ 31.7 years as a delta. Absurd either way, which is why
    // the floor sits where no real epoch is and no real delta reaches.
    expect(parseRetryAfter("999999999", NOW)).toBe(999_999_999_000);
    expect(parseRetryAfter("1000000000", NOW)).toBe(
      Math.max(0, 1_000_000_000_000 - NOW),
    );
  });
});

describe("what says nothing", () => {
  test("absent, empty and unparseable are all `undefined`, never a guess", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("   ", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
  });
});

describe("picking a header out of a response", () => {
  test("the standard one wins over a vendor one, whatever the casing", () => {
    expect(
      retryAfterFromHeaders(
        { "Retry-After": "10", "x-ratelimit-reset": String(NOW / 1000 + 600) },
        [],
        NOW,
      ),
    ).toBe(10_000);
  });

  test("a provider's declared header is tried before the common vendor spellings", () => {
    // Nango's own provider config carries this idea (`retry.after`/`retry.at`):
    // the NAME varies per integration, the meaning does not.
    expect(
      retryAfterFromHeaders(
        { "x-cooldown": "7", "x-ratelimit-reset": String(NOW / 1000 + 600) },
        ["X-Cooldown"],
        NOW,
      ),
    ).toBe(7_000);
  });

  test("a header that parses to nothing does not stop the next one being read", () => {
    // Only `Retry-After` differs from the first case. A parser that returned
    // early on a present-but-garbage header would silently lose the good one
    // beside it.
    expect(
      retryAfterFromHeaders(
        {
          "Retry-After": "later",
          "x-ratelimit-reset": String(NOW / 1000 + 20),
        },
        [],
        NOW,
      ),
    ).toBe(20_000);
  });

  test("nothing readable is `undefined` — the caller's default is its own", () => {
    expect(
      retryAfterFromHeaders({ "content-type": "text/html" }, [], NOW),
    ).toBeUndefined();
  });
});
