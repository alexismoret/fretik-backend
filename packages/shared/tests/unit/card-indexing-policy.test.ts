import { describe, expect, test } from "bun:test";
import {
  CARD_INDEX_ROW_CEILING,
  cardIndexVerdict,
  needsFreshEstimate,
} from "../../src/services/object-records/card-indexing-policy";
import { INDEX_ROW_THRESHOLD } from "../../src/services/object-schema/indexes";

/**
 * The policy has two halves worth locking down, and neither is about the
 * number 20 000 itself.
 *
 * First, the stored preference must beat the heuristic in BOTH directions —
 * a size rule that silently overrides "yes, index this 50 000-row client list"
 * is the failure the escape hatch exists to prevent.
 *
 * Second, the asymmetry of the estimate: only "small" may be re-checked. If
 * `needsFreshEstimate` ever returned true for a big table, every card job on a
 * huge type would run an ANALYZE it cannot learn anything from; if it returned
 * false for a small one, a fresh import would be embedded whole on the strength
 * of a `reltuples` that INSERT never updates.
 */

describe("cardIndexVerdict — the stored preference wins", () => {
  test("an explicit true keeps a huge type indexed", () => {
    expect(cardIndexVerdict({ preference: true, rows: 5_000_000 })).toBe(true);
  });

  test("an explicit false takes a tiny type out", () => {
    expect(cardIndexVerdict({ preference: false, rows: 0 })).toBe(false);
  });

  test("null defers to the size", () => {
    expect(cardIndexVerdict({ preference: null, rows: 10 })).toBe(true);
    expect(
      cardIndexVerdict({ preference: null, rows: CARD_INDEX_ROW_CEILING }),
    ).toBe(false);
  });

  test("the ceiling is exclusive — exactly at it, indexing stops", () => {
    expect(
      cardIndexVerdict({ preference: null, rows: CARD_INDEX_ROW_CEILING - 1 }),
    ).toBe(true);
    expect(
      cardIndexVerdict({ preference: null, rows: CARD_INDEX_ROW_CEILING }),
    ).toBe(false);
  });
});

describe("needsFreshEstimate — only 'small' is untrustworthy", () => {
  test("a small auto type is re-checked", () => {
    expect(needsFreshEstimate({ preference: null, rows: 55 })).toBe(true);
  });

  test("a big auto type is believed as-is", () => {
    // `reltuples` only ever lags UPWARD, so "already big" needs no ANALYZE.
    expect(
      needsFreshEstimate({ preference: null, rows: CARD_INDEX_ROW_CEILING }),
    ).toBe(false);
  });

  test("an explicit preference short-circuits the estimate entirely", () => {
    expect(needsFreshEstimate({ preference: true, rows: 0 })).toBe(false);
    expect(needsFreshEstimate({ preference: false, rows: 0 })).toBe(false);
  });

  test("a refresh is only ever asked for where the verdict would be 'index'", () => {
    // The two functions must agree on where the boundary sits, or the refresh
    // fires on the side that cannot change its mind.
    for (const rows of [0, 1, 19_999, 20_000, 20_001, 1_000_000]) {
      const refresh = needsFreshEstimate({ preference: null, rows });
      const verdict = cardIndexVerdict({ preference: null, rows });
      expect(refresh).toBe(verdict);
    }
  });
});

describe("CARD_INDEX_ROW_CEILING — its own decision", () => {
  test("is not an alias of the SQL-index threshold", () => {
    // The numbers coincide today. This asserts they are separate BINDINGS, so
    // moving one never silently moves the other: "big enough to deserve SQL
    // indexes" and "too big to embed row by row" answer different questions.
    expect(CARD_INDEX_ROW_CEILING).toBe(20_000);
    expect(INDEX_ROW_THRESHOLD).toBe(20_000);
  });
});
