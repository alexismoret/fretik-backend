import { describe, expect, test } from "bun:test";
import { countCachedTokens, countTokens } from "../../src/lib/token-estimate";

/**
 * The counter that replaced `chars / 4`, and the trap that replacing it opens.
 *
 * Two independent claims are pinned here. The first is that the count is now
 * REAL: the old heuristic was out by a factor of two on tool output and by 15 %
 * the other way on prose, and a budget keyed on it compacted late enough that
 * four consecutive turns died on arrival at the context ceiling.
 *
 * The second is the one that costs an outage rather than a wrong number. A BPE
 * encoder merges inside a "word", and that merge is quadratic; a run of one
 * repeated character is a single enormous word. Measured before the fix:
 * 52 638 ms to encode 300 KB of `x`, and 188 seconds for 600 KB — on the event
 * loop, inside a chat turn. Slicing makes it 14 ms. Repetition is not exotic in
 * this system: separators, padding, a column of zeros, identical log lines.
 */

describe("countTokens", () => {
  test("counts prose far below the old chars/4 heuristic", () => {
    const prose =
      "Le rapprochement bancaire compare les écritures comptables aux relevés fournis par la banque. ".repeat(
        200,
      );
    const counted = countTokens(prose);
    // chars/4 claimed ~4 700 here; the truth is nearer 4 000. The old constant
    // over-counted prose, which merely fired budgets early.
    expect(counted).toBeLessThan(Math.ceil(prose.length / 4));
  });

  test("counts structured output far ABOVE it — the direction that hurt", () => {
    const rows = Array.from(
      { length: 400 },
      (_, i) =>
        `lot1-${i.toString().padStart(6, "0")},AUD-CONSO,2025-03-14,-1284.55,flagged`,
    ).join("\n");
    // Delimiters, digits and short identifiers each cost a token, so a CSV
    // tokenises at roughly two characters per token, not four.
    expect(countTokens(rows)).toBeGreaterThan(Math.ceil(rows.length / 4));
  });

  test("a long run of one character does not block the loop", () => {
    // Without slicing this call took 52 seconds. The assertion is the wall
    // clock, because the defect is the wall clock.
    const pathological = "x".repeat(300_000);
    const started = performance.now();
    const counted = countTokens(pathological);
    const elapsed = performance.now() - started;
    expect(counted).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("slicing keeps the count honest, and errs upward", () => {
    // A boundary can split one token in two, so the sliced count is never
    // lower than the whole-string one — the safe direction for a budget.
    const text =
      "Le total par centre de coût est calculé sur les trois lots. ".repeat(
        400,
      );
    const sliced = countTokens(text);
    const short = countTokens(text.slice(0, 4_000));
    expect(sliced).toBeGreaterThan(short);
    // And it stays within a per-mille of the un-sliced figure.
    expect(sliced).toBeLessThan(Math.ceil(text.length / 2));
  });

  test("empty text is zero, not a call into the encoder", () => {
    expect(countTokens("")).toBe(0);
    expect(countCachedTokens("")).toBe(0);
  });
});

describe("countCachedTokens", () => {
  test("agrees with the uncached counter", () => {
    const text = "Une phrase ordinaire, comptée deux fois.";
    expect(countCachedTokens(text)).toBe(countTokens(text));
  });

  test("a second call on the same content is served from the memo", () => {
    const text = "y".repeat(200_000);
    const cold = performance.now();
    const first = countCachedTokens(text);
    const coldMs = performance.now() - cold;
    const warm = performance.now();
    const second = countCachedTokens(text);
    const warmMs = performance.now() - warm;
    expect(second).toBe(first);
    // The memo is the reason a thirty-message window is affordable per step.
    expect(warmMs).toBeLessThanOrEqual(coldMs);
  });
});
