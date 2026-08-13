import { describe, expect, test } from "bun:test";
import { BULK_OPERATION_ERROR_LIMIT } from "../../src/db/schema/bulk-operations";
import {
  emptyProgress,
  foldChunkProgress,
} from "../../src/services/bulk-operations/progress";

/**
 * The tally a 200 000-row import is reported through. Three properties carry
 * the weight, and all three are load-bearing rather than cosmetic:
 *
 *  - it folds the SAME way whether the chunks arrive from the inline path or
 *    from a worker resuming after a crash (which re-folds from the ledger);
 *  - the error list is capped while the count is not, so a load where every
 *    row is malformed reports the truth without storing it;
 *  - a reported index is a row number in the CALLER's original list, not a
 *    position inside some chunk the caller never saw.
 */

const chunk = (
  succeeded: number,
  failed: number,
  errors: { index: number; error: string }[] = [],
) => ({ succeeded, failed, errors });

describe("bulk progress — counters", () => {
  test("an empty tally is all zeroes", () => {
    expect(emptyProgress()).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
      errorCount: 0,
      errors: [],
    });
  });

  test("processed is succeeded + failed, accumulated", () => {
    let p = emptyProgress();
    p = foldChunkProgress(p, chunk(500, 0), 0);
    p = foldChunkProgress(p, chunk(498, 2), 500);
    expect(p.succeeded).toBe(998);
    expect(p.failed).toBe(2);
    expect(p.processed).toBe(1000);
  });

  test("folding does not mutate the tally it was given", () => {
    const base = foldChunkProgress(emptyProgress(), chunk(10, 0), 0);
    const snapshot = structuredClone(base);
    foldChunkProgress(base, chunk(10, 0), 10);
    expect(base).toEqual(snapshot);
  });

  test("chunk order does not change the totals", () => {
    const a = foldChunkProgress(
      foldChunkProgress(emptyProgress(), chunk(3, 1), 0),
      chunk(5, 2),
      100,
    );
    const b = foldChunkProgress(
      foldChunkProgress(emptyProgress(), chunk(5, 2), 100),
      chunk(3, 1),
      0,
    );
    expect(a.succeeded).toBe(b.succeeded);
    expect(a.failed).toBe(b.failed);
    expect(a.processed).toBe(b.processed);
    expect(a.errorCount).toBe(b.errorCount);
  });
});

describe("bulk progress — folding is NOT idempotent, and callers must know", () => {
  test("the same chunk folded twice is counted twice", () => {
    // Not a defect to fix here: the fold is a pure accumulator and has no
    // notion of chunk identity. It is stated as a test because a real probe
    // caught the consequence — a re-sent chunk (retried request, resumed loop)
    // reported 7 000 rows written for a 5 000-row load while the table held the
    // correct 5 000. The guard lives at the call site, which knows whether the
    // chunk had already been applied (`chunkAlreadyApplied`).
    //
    // If this ever starts passing as "counted once", the guard can go.
    const once = foldChunkProgress(emptyProgress(), chunk(2000, 0), 0);
    const twice = foldChunkProgress(once, chunk(2000, 0), 0);
    expect(twice.succeeded).toBe(4000);
  });
});

describe("bulk progress — error indexes are the caller's row numbers", () => {
  test("the chunk offset is added to every local index", () => {
    const p = foldChunkProgress(
      emptyProgress(),
      chunk(1998, 2, [
        { index: 0, error: "bad vat" },
        { index: 1999, error: "bad date" },
      ]),
      // Chunk 3 of a 2 000-row chunking.
      6000,
    );
    expect(p.errors).toEqual([
      { index: 6000, error: "bad vat" },
      { index: 7999, error: "bad date" },
    ]);
  });
});

describe("bulk progress — the cap tells the truth", () => {
  const flood = (n: number, from: number) =>
    chunk(
      0,
      n,
      Array.from({ length: n }, (_, i) => ({
        index: i,
        error: `row ${(from + i).toString()} invalid`,
      })),
    );

  test("errors stop at the limit while errorCount keeps counting", () => {
    let p = emptyProgress();
    for (let i = 0; i < 10; i += 1) {
      p = foldChunkProgress(p, flood(40, i * 40), i * 40);
    }
    expect(p.errors.length).toBe(BULK_OPERATION_ERROR_LIMIT);
    expect(p.errorCount).toBe(400);
    expect(p.failed).toBe(400);
  });

  test("the kept errors are the FIRST ones — the ones that explain why", () => {
    let p = emptyProgress();
    p = foldChunkProgress(p, flood(60, 0), 0);
    p = foldChunkProgress(p, flood(60, 60), 60);
    expect(p.errors[0]).toEqual({ index: 0, error: "row 0 invalid" });
    expect(p.errors.length).toBe(BULK_OPERATION_ERROR_LIMIT);
    // Nothing from the second chunk got in — the list was already full.
    expect(p.errors.every((e) => e.index < 60)).toBe(true);
  });

  test("a single chunk larger than the cap is truncated, not dropped", () => {
    const p = foldChunkProgress(emptyProgress(), flood(500, 0), 0);
    expect(p.errors.length).toBe(BULK_OPERATION_ERROR_LIMIT);
    expect(p.errorCount).toBe(500);
  });
});
