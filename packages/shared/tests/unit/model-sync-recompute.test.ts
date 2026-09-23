import { describe, expect, test } from "bun:test";
import type { EndpointStat } from "../../src/model-registry/types";
import {
  type RecomputeRowState,
  recomputeRowPool,
} from "../../src/services/model-registry/sync/recompute";

/**
 * The one definition of what a model routes to.
 *
 * It was inline in `syncOneModel` while the nightly pass was the only thing
 * that could change a pool. An operator setting a price ceiling changes the
 * same five outputs, and a second copy of this arithmetic is how the pool
 * someone is shown stops matching the pool the next pass writes — so what these
 * tests pin is not the maths, which `model-sync-compute.test.ts` already
 * covers, but the SHAPE both callers depend on: the vetted-pool literal, the
 * anti-ratchet, and which policy grades which status.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"],
  hasZdr: true,
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

const row = (over: Partial<RecomputeRowState> = {}): RecomputeRowState => ({
  profileKey: "acme-m1",
  status: "published",
  providerPool: {},
  poolWidened: false,
  maxInputPricePerMTok: null,
  maxOutputPricePerMTok: null,
  minMaxOutput: null,
  minContextLength: null,
  requireCache: null,
  boundRoles: [],
  ...over,
});

const three = [
  endpoint({ provider: "deepinfra" }),
  endpoint({
    provider: "dear",
    pricing: { inputPerMTok: 9, outputPerMTok: 40 },
  }),
  endpoint({ provider: "novita" }),
];

describe("recomputeRowPool", () => {
  test("the vetted pool carries `only` and `sort`, and never `order`", () => {
    const { vettedPool } = recomputeRowPool({
      row: row(),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(vettedPool).toEqual({
      only: ["deepinfra", "dear", "novita"],
      sort: "throughput",
    });
    // `order` would be silently fatal twice over: OpenRouter drops `sort` when
    // both are present, and an explicit order also disables the sticky routing
    // that keeps a multi-step turn on one warm cache.
    expect(vettedPool?.order).toBeUndefined();
  });

  test("`ignore` is carried across the recompute, `only` is not", () => {
    // The stored `only` names one host. Feeding it back would exclude the
    // other two as "not in the declared pool" and the list could only shrink —
    // the ratchet that made every seven-day quarantine permanent.
    const { vettedPool } = recomputeRowPool({
      row: row({
        providerPool: {
          openrouter: { only: ["deepinfra"], ignore: ["someoneelse"] },
        },
      }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(vettedPool?.only).toEqual(["deepinfra", "dear", "novita"]);
    expect(vettedPool?.ignore).toEqual(["someoneelse"]);
  });

  test("an empty pool yields no vetted pool at all, never an empty `only`", () => {
    // The caller relies on `undefined` to mean "do not overwrite what is
    // stored". An empty allow-list on the wire means "nothing may serve this".
    const { vettedPool, pool } = recomputeRowPool({
      row: row(),
      endpoints: [],
      transport: "openrouter",
      quarantined: [],
    });
    expect(pool.endpoints).toHaveLength(0);
    expect(vettedPool).toBeUndefined();
  });

  test("the quarantine list is the CALLER's, not the row's", () => {
    // The sync re-probes expired quarantines before recomputing, so it knows a
    // host is free before the row does. Recomputing off the stored array would
    // hold a released host out for one more day.
    const { pool } = recomputeRowPool({
      row: row(),
      endpoints: three,
      transport: "openrouter",
      quarantined: ["novita"],
    });
    expect(pool.endpoints.map((e) => e.provider)).toEqual([
      "deepinfra",
      "dear",
    ]);
  });

  test("status picks the policy, and the policy is returned for the caller to grade with", () => {
    const published = recomputeRowPool({
      row: row({ status: "published" }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    const candidate = recomputeRowPool({
      row: row({ status: "candidate" }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    // The two differ — that is the whole reason the policy travels back out
    // rather than being chosen again by the caller.
    expect(published.policy).not.toBe(candidate.policy);
  });

  test("operator limits reach the pool, the price and the context", () => {
    const capped = recomputeRowPool({
      row: row({ maxInputPricePerMTok: 2 }),
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(capped.pool.endpoints.map((e) => e.provider)).toEqual([
      "deepinfra",
      "novita",
    ]);
    expect(capped.vettedPool?.only).toEqual(["deepinfra", "novita"]);
    // The expensive host was dragging the median; removing it is the point.
    expect(capped.pricing.inputPerMTok).toBe(1);
  });
});

/**
 * The cache filter had been wired end to end and never once fired.
 *
 * `requireCache: true` sits on every agent role, `filterPool` calls
 * `cacheEvidenceFor`, and that ladder's first arm reads
 * `measuredCacheReadRatio` — which no source wrote, so every endpoint fell
 * through to `unknown`, and `unknown` never excludes. The pool was composed on
 * published prices alone.
 *
 * Published prices are not the same claim. Measured 2026-09-22 on
 * `z-ai/glm-5.3-flash`, `morph` publishes a cache-read price below its prompt
 * price — so every advertised signal says it caches — and returned 0 % cache
 * read over seven days of our own traffic, at $0.745 per MTok of input against
 * $0.025 for the best host in the same pool. A sticky session seeded there
 * never pinned either, because OpenRouter activates one on an actual cache.
 */
describe("recomputeRowPool — our own cache measurement", () => {
  const cacheRow = row({ requireCache: true });

  test("with nothing measured, no host is excluded for caching", () => {
    // The state before this change, pinned so the filter cannot start firing
    // on absence. A host removed for want of data never gets the traffic that
    // would measure it.
    const { vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
    });
    expect(vettedPool?.only).toEqual(["deepinfra", "dear", "novita"]);
  });

  test("a host WE measured as not caching leaves the pool", () => {
    const { pool, vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
      measured: new Map([
        ["dear", { measuredCacheReadRatio: 0.0, measuredCacheSamples: 400 }],
      ]),
    });
    expect(vettedPool?.only).toEqual(["deepinfra", "novita"]);
    expect(pool.excluded.map((e) => e.provider)).toContain("dear");
    expect(pool.excluded.find((e) => e.provider === "dear")?.reason).toContain(
      "no cache",
    );
  });

  test("a host we measured as caching stays", () => {
    const { vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
      measured: new Map([
        ["dear", { measuredCacheReadRatio: 0.8, measuredCacheSamples: 400 }],
      ]),
    });
    expect(vettedPool?.only).toContain("dear");
  });

  test("a ratio drawn from too few calls is an anecdote, not a measurement", () => {
    // The sample gate is about CALLS. Reading it off `sampleCount` — the capped
    // tps/ttft reservoir, a different unit — would admit a verdict from a
    // handful of requests, which is how a busy host gets evicted on a bad hour.
    const { vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
      measured: new Map([
        ["dear", { measuredCacheReadRatio: 0.0, measuredCacheSamples: 3 }],
      ]),
    });
    expect(vettedPool?.only).toContain("dear");
  });

  test("the filter yields rather than emptying the pool", () => {
    // Same rule as every other capability floor: `only: []` is a 404 upstream,
    // so a filter that would leave nothing standing gives way instead.
    const { vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
      measured: new Map(
        three.map((e) => [
          e.provider,
          { measuredCacheReadRatio: 0, measuredCacheSamples: 400 },
        ]),
      ),
    });
    expect(vettedPool?.only?.length).toBeGreaterThan(0);
  });

  test("a measurement without its sample count is ignored, not half-applied", () => {
    // `cacheEvidenceFor` refuses a ratio whose sample count it cannot see, so
    // folding one without the other would look like a measurement that
    // silently never applies.
    const { vettedPool } = recomputeRowPool({
      row: cacheRow,
      endpoints: three,
      transport: "openrouter",
      quarantined: [],
      measured: new Map([["dear", { measuredCacheReadRatio: 0 }]]),
    });
    expect(vettedPool?.only).toContain("dear");
  });
});
