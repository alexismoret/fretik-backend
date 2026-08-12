import { describe, expect, test } from "bun:test";
import {
  chunkSizeForParams,
  DB_BULK_CHUNK_SIZE,
  MAX_BULK_CHUNK_SIZE,
  MIN_BULK_CHUNK_SIZE,
  PG_MAX_BIND_PARAMS,
} from "../../src/lib/db-bulk";

/**
 * The chunk size stopped being a constant and became a function of how wide one
 * row of a given object type is. Exactly one property is a correctness
 * requirement rather than a tuning preference: `rows × paramsPerRow` must never
 * reach Postgres' bind-parameter ceiling, because crossing it is not a slow
 * query, it is a failed statement in the middle of a load.
 *
 * The trap this locks down is the FLOOR: clamping a very wide type back up to a
 * minimum row count is exactly how a "safety" bound overflows the limit it was
 * meant to respect.
 */

describe("chunkSizeForParams — never crosses the bind ceiling", () => {
  test("holds for every plausible row width", () => {
    // 1 → far past what a type can have (money is 2 columns per field, and the
    // schema caps fields well below this).
    for (let paramsPerRow = 1; paramsPerRow <= 2_000; paramsPerRow += 1) {
      const rows = chunkSizeForParams(paramsPerRow);
      expect(rows * paramsPerRow).toBeLessThanOrEqual(PG_MAX_BIND_PARAMS);
      expect(rows).toBeGreaterThanOrEqual(1);
    }
  });

  test("a type wide enough to break the floor still fits", () => {
    // 400 params/row: the floor (200) would bind 80 000 — over the ceiling.
    const rows = chunkSizeForParams(400);
    expect(rows).toBeLessThan(MIN_BULK_CHUNK_SIZE);
    expect(rows * 400).toBeLessThanOrEqual(PG_MAX_BIND_PARAMS);
  });

  test("an absurd width degrades to one row rather than zero", () => {
    expect(chunkSizeForParams(PG_MAX_BIND_PARAMS * 2)).toBe(1);
  });
});

describe("chunkSizeForParams — the tuning bounds", () => {
  test("a narrow type gets the maximum, not the old fixed 500", () => {
    // 5 columns: the fixed size wasted four fifths of every round-trip.
    const rows = chunkSizeForParams(5);
    expect(rows).toBe(MAX_BULK_CHUNK_SIZE);
    expect(rows).toBeGreaterThan(DB_BULK_CHUNK_SIZE);
  });

  test("a wide type gets fewer rows than a narrow one", () => {
    expect(chunkSizeForParams(100)).toBeLessThan(chunkSizeForParams(10));
  });

  test("is monotonically non-increasing in the row width", () => {
    let previous = chunkSizeForParams(1);
    for (let paramsPerRow = 2; paramsPerRow <= 500; paramsPerRow += 1) {
      const rows = chunkSizeForParams(paramsPerRow);
      expect(rows).toBeLessThanOrEqual(previous);
      previous = rows;
    }
  });

  test("keeps headroom under the raw ceiling at ordinary widths", () => {
    // 20 % margin: a caller that under-counts by a column or two is still safe.
    const rows = chunkSizeForParams(50);
    expect(rows * 50).toBeLessThanOrEqual(PG_MAX_BIND_PARAMS * 0.8);
  });
});

describe("chunkSizeForParams — degenerate input", () => {
  test("falls back to the fixed size rather than dividing by zero", () => {
    expect(chunkSizeForParams(0)).toBe(DB_BULK_CHUNK_SIZE);
    expect(chunkSizeForParams(-1)).toBe(DB_BULK_CHUNK_SIZE);
    expect(chunkSizeForParams(Number.NaN)).toBe(DB_BULK_CHUNK_SIZE);
  });
});
