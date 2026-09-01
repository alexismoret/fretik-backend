import { describe, expect, test } from "bun:test";
import {
  bucketStartFor,
  TELEMETRY_MIN_SAMPLES,
} from "../../src/services/model-registry/telemetry";
import { percentile } from "../../src/services/model-registry/telemetry-rollup";

/**
 * The arithmetic behind the rollup, which is where a quiet mistake would be
 * least visible: a wrong percentile does not throw, it just grades the fleet
 * on a number nobody can trace back.
 */

describe("percentile", () => {
  test("nearest-rank, not interpolated", () => {
    // Ten samples: the p50 is the 5th, the p95 the 10th. Interpolating would
    // invent values that were never observed, which is the wrong trade for a
    // figure a policy floor is compared against.
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(100);
  });

  test("does not require sorted input", () => {
    expect(percentile([90, 10, 50, 30, 70], 0.5)).toBe(50);
  });

  test("a single sample is its own percentile", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  test("no samples yields undefined, never zero", () => {
    // A zero here would be written to the rollup and read downstream as "this
    // host decodes at 0 tok/s" — a measurement, rather than the absence of one.
    expect(percentile([], 0.5)).toBeUndefined();
  });

  test("the sample list is not mutated", () => {
    // It is read straight off a Redis reservoir that the caller also counts.
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("bucketStartFor", () => {
  test("floors to the UTC hour", () => {
    expect(
      bucketStartFor(new Date("2026-09-01T14:37:52.481Z")).toISOString(),
    ).toBe("2026-09-01T14:00:00.000Z");
  });

  test("two calls in the same hour share a bucket", () => {
    // The property the whole scheme rests on: the key is derived from the
    // timestamp, so concurrent writers on different replicas land on one hash
    // without coordinating.
    expect(bucketStartFor(new Date("2026-09-01T14:00:00.000Z"))).toEqual(
      bucketStartFor(new Date("2026-09-01T14:59:59.999Z")),
    );
  });

  test("a local midnight does not shift the bucket", () => {
    // UTC everywhere, like every other stamp in the registry. A local hour
    // would make buckets from two replicas in different zones disagree.
    const at = new Date("2026-09-01T23:30:00.000Z");
    expect(bucketStartFor(at).getUTCHours()).toBe(23);
  });
});

describe("the sample floor", () => {
  test("is high enough that a percentile means something", () => {
    // Guards the constant against a well-meaning reduction: a p95 over a
    // handful of calls is not a p95, and letting one unlucky afternoon
    // override a vendor's 30-day aggregate would make the grading noisier
    // than the thing it replaced.
    expect(TELEMETRY_MIN_SAMPLES).toBeGreaterThanOrEqual(20);
  });
});
