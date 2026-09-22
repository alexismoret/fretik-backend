import { beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import db from "../../../src/db";
import { modelTelemetryRollups } from "../../../src/db/schema";
import { readMeasuredEndpointStats } from "../../../src/services/model-registry/telemetry";

/**
 * The aggregation that decides which upstreams a pool may contain, run against
 * the database that computes it.
 *
 * It had no test of any kind. It is a weighted average with a `nullif`, a
 * conditional sum cast to `int`, and two signals summarised over the same rows
 * under two different units — none of which a typechecker can be wrong about
 * and all of which SQL can. What rides on the answer is not a statistic: a
 * ratio that comes back too low removes a host from a live pool, and the only
 * symptom is slower routing.
 *
 * Every row here is built to break one specific way of writing the query, and
 * the rule that sorts them is the package's own: if the assertion still holds
 * when you delete the `where` clause, the test is not testing the query.
 */

const KEYS = ["tel-test-weight", "tel-test-gate", "tel-test-units"];
const NOW = new Date();
const hoursAgo = (n: number): Date =>
  new Date(NOW.getTime() - n * 60 * 60 * 1000);

interface RollupOver {
  profileKey: string;
  provider: string;
  bucketStart: Date;
  calls: number;
  cacheReadRatio: number | null;
  sampleCount?: number;
  tpsP50?: number | null;
}

const rollup = (over: RollupOver) => ({
  transport: "openrouter" as const,
  errors: 0,
  costMicroUsd: 1,
  sampleCount: over.sampleCount ?? 0,
  tpsP50: over.tpsP50 ?? null,
  ...over,
});

beforeEach(async () => {
  await db
    .delete(modelTelemetryRollups)
    .where(inArray(modelTelemetryRollups.profileKey, KEYS));
});

describe("readMeasuredEndpointStats — the cache ratio", () => {
  test("is weighted by CALLS, so a busy hour outvotes a quiet one", async () => {
    // A plain average of the two buckets gives 0.50 and the host is kept; the
    // weighted one gives 0.109 and it goes. Both are one character apart in
    // SQL, and only one of them is what "this host does not cache" means.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[0] ?? "",
        provider: "busy",
        bucketStart: hoursAgo(2),
        calls: 1000,
        cacheReadRatio: 0.05,
      }),
      rollup({
        profileKey: KEYS[0] ?? "",
        provider: "busy",
        bucketStart: hoursAgo(1),
        calls: 100,
        cacheReadRatio: 0.95,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[0] ?? "");
    const busy = stats.get("busy");
    expect(busy?.measuredCacheReadRatio).toBeCloseTo(0.1318, 3);
    expect(busy?.measuredCacheSamples).toBe(1100);
  });

  test("a bucket that reported no ratio is excluded from the denominator", async () => {
    // The `nullif`/`case` pair. Dividing by the TOTAL calls instead would
    // read the silent hour as an hour of zero cache and halve the answer —
    // which is how a host that caches perfectly gets evicted for a gap in
    // what the transport reported.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[1] ?? "",
        provider: "partial",
        bucketStart: hoursAgo(2),
        calls: 100,
        cacheReadRatio: 0.8,
      }),
      rollup({
        profileKey: KEYS[1] ?? "",
        provider: "partial",
        bucketStart: hoursAgo(1),
        calls: 100,
        cacheReadRatio: null,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[1] ?? "");
    expect(stats.get("partial")?.measuredCacheReadRatio).toBeCloseTo(0.8, 5);
    // And the sample count counts only the calls that reported one: a verdict
    // must not borrow confidence from hours it could not see.
    expect(stats.get("partial")?.measuredCacheSamples).toBe(100);
  });

  test("a host with no ratio anywhere reports none, rather than zero", async () => {
    // Zero is a verdict — "this host does not cache" — and absence is not.
    // `sum(...) / nullif(0, 0)` is NULL; a `coalesce` around it would turn
    // every unmeasured host into a host that failed.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[1] ?? "",
        provider: "silent",
        bucketStart: hoursAgo(1),
        calls: 500,
        cacheReadRatio: null,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[1] ?? "");
    expect(stats.get("silent")?.measuredCacheReadRatio).toBeUndefined();
    expect(stats.get("silent")?.measuredCacheSamples).toBeUndefined();
  });

  test("too few CALLS is an anecdote, whatever the latency reservoir says", async () => {
    // The two signals are summarised over the same rows in different units:
    // `sampleCount` is a capped latency reservoir, `calls` is traffic. Gating
    // the cache verdict on `sampleCount` would admit a ratio drawn from ten
    // requests on any host busy enough to fill the reservoir.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[2] ?? "",
        provider: "anecdote",
        bucketStart: hoursAgo(1),
        calls: 10,
        cacheReadRatio: 0.0,
        sampleCount: 400,
        tpsP50: 90,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[2] ?? "");
    const anecdote = stats.get("anecdote");
    expect(anecdote?.measuredCacheReadRatio).toBeUndefined();
    // …while the SPEED signal, whose gate that reservoir IS, comes through.
    // One gate refusing must not take the other's answer with it.
    expect(anecdote?.throughputP50).toBeCloseTo(90, 5);
  });

  test("buckets older than the window do not count", async () => {
    // Delete the `where` on `bucketStart` and this is the assertion that
    // fails: a host judged on last month's behaviour is judged on a fleet
    // that no longer exists.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[2] ?? "",
        provider: "stale",
        bucketStart: hoursAgo(24 * 30),
        calls: 5000,
        cacheReadRatio: 0.0,
      }),
      rollup({
        profileKey: KEYS[2] ?? "",
        provider: "stale",
        bucketStart: hoursAgo(1),
        calls: 100,
        cacheReadRatio: 0.9,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[2] ?? "");
    expect(stats.get("stale")?.measuredCacheReadRatio).toBeCloseTo(0.9, 5);
    expect(stats.get("stale")?.measuredCacheSamples).toBe(100);
  });

  test("rows of another model are not folded in", async () => {
    // The other `where`. One shared upstream serves many models, and its
    // cache behaviour is a property of the (model, host) pair — GLM's prefix
    // on CoreWeave says nothing about gpt-oss's.
    await db.insert(modelTelemetryRollups).values([
      rollup({
        profileKey: KEYS[0] ?? "",
        provider: "shared",
        bucketStart: hoursAgo(1),
        calls: 100,
        cacheReadRatio: 0.9,
      }),
      rollup({
        profileKey: KEYS[1] ?? "",
        provider: "shared",
        bucketStart: hoursAgo(1),
        calls: 900,
        cacheReadRatio: 0.0,
      }),
    ]);

    const stats = await readMeasuredEndpointStats(KEYS[0] ?? "");
    expect(stats.get("shared")?.measuredCacheReadRatio).toBeCloseTo(0.9, 5);
    expect(stats.get("shared")?.measuredCacheSamples).toBe(100);
  });
});
