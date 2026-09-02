import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { beforeEach, describe, expect, test } from "bun:test";
import { clearSynthesisedProfileCache } from "../../../src/lib/model-registry/effective";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import { costLevelFromProfile } from "../../../src/services/model-metrics/cost-level";
import { FALLBACK_METRICS } from "../../../src/services/model-metrics/fallback";
import { buildModelMetricsSnapshot } from "../../../src/services/model-metrics/refresh";
import { BOUND_ROWS, boundProfile, dynamic } from "../../lib/live-fleet";
import { setLiveStateDouble } from "../../lib/live-state-double";

/**
 * The metrics snapshot after it stopped calling Artificial Analysis and
 * OpenRouter itself (2026-08-30) and became a reader of `model_live_state`.
 *
 * The collapse removed a whole class of drift — two clients paginating the same
 * 100-requests-a-day catalogue, and a per-profile OpenRouter probe re-learning
 * what `endpointStats` already records — but it moved the question of WHICH
 * endpoint describes a model into this file. These cases pin that answer.
 */

/** A key that certainly exists, whatever the fleet is renamed to. */
const KEY = ROLE_BINDINGS.chat.profileKey;

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

const row = (over: Partial<LiveModelState> = {}): LiveModelState => ({
  profileKey: KEY,
  status: "published",
  transport: "openrouter",
  enabled: true,
  disabledReason: null,
  modelIds: { openrouter: "vendor/model" },
  providerPool: {},
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 128_000,
  effectiveMaxOutput: 8_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  creditMultiplier: 1,
  health: "healthy",
  healthScore: 100,
  policyReport: null,
  endpointStats: [],
  aaMetrics: null,
  aaSlug: null,
  // A row the sync has DESCRIBED. Without one there is no profile to hang a
  // metric on — the registry is the rows, so an undescribed row is not a model
  // with missing grades, it is not a model yet.
  dynamicProfile: dynamic(),
  boundRoles: [],
  source: "sync",
  releasedAt: null,
  syncedAt: new Date(),
  ...over,
});

/**
 * Build a snapshot with the same rows installed as the live registry.
 *
 * A metrics snapshot has two inputs that used to be one. Which models EXIST
 * comes from the warmed registry — which is the rows, since there is no
 * TypeScript registry behind it any more — while which models have been GRADED
 * comes from the rows handed in. A test passing fresher grades still needs the
 * model to exist.
 */
const snapshotOf = (graded: LiveModelState[] = []) => {
  setLiveStateDouble(graded.length > 0 ? graded : [row()]);
  return buildModelMetricsSnapshot(graded);
};

// Synthesised profiles are memoised per snapshot; in production the same call
// that drops memoised model instances clears them. Here the snapshot is swapped
// between cases, so the cache has to go with it or one case prices another's
// model.
beforeEach(() => {
  clearSynthesisedProfileCache();
});

describe("which endpoint describes the model", () => {
  test("speed is the FASTEST endpoint in the pool, not the median", () => {
    // Every pool routes with `sort: "throughput"`, so the fastest reachable
    // endpoint serves unless it is down. A median would describe a route the
    // model reaches only when its best host is unavailable.
    const snapshot = snapshotOf([
      row({
        endpointStats: [
          endpoint({ provider: "slow", throughputP50: 20 }),
          endpoint({ provider: "fast", throughputP50: 180 }),
          endpoint({ provider: "middling", throughputP50: 60 }),
        ],
      }),
    ]);
    expect(snapshot.metrics[KEY]?.speed).toBe(180);
  });

  test("latency comes from that SAME endpoint, never best-of-each", () => {
    // A speed taken from one host and a latency from another describes a route
    // that does not exist. Here the fastest host is also the slower to start,
    // which is the case where the distinction is visible.
    const snapshot = snapshotOf([
      row({
        endpointStats: [
          endpoint({
            provider: "snappy",
            throughputP50: 40,
            latencyP50Ms: 200,
          }),
          endpoint({
            provider: "fast",
            throughputP50: 180,
            latencyP50Ms: 2_400,
          }),
        ],
      }),
    ]);
    expect(snapshot.metrics[KEY]?.speed).toBe(180);
    expect(snapshot.metrics[KEY]?.ttftSeconds).toBe(2.4);
  });

  test("an endpoint with no throughput figure cannot be the serving one", () => {
    // Absent is not zero and not fastest: it simply cannot be ranked.
    const snapshot = snapshotOf([
      row({
        endpointStats: [
          endpoint({ provider: "unmeasured" }),
          endpoint({
            provider: "measured",
            throughputP50: 55,
            latencyP50Ms: 900,
          }),
        ],
      }),
    ]);
    expect(snapshot.metrics[KEY]?.speed).toBe(55);
    expect(snapshot.metrics[KEY]?.ttftSeconds).toBe(0.9);
  });

  test("a pool with no measured endpoint falls back rather than reporting zero", () => {
    const snapshot = snapshotOf([
      row({ endpointStats: [endpoint({ provider: "silent" })] }),
    ]);
    expect(snapshot.metrics[KEY]?.speed).toBe(
      FALLBACK_METRICS[KEY]?.speed ?? null,
    );
    expect(snapshot.metrics[KEY]?.ttftSeconds).toBeNull();
  });
});

describe("grades", () => {
  test("tool reliability reads the AGENTIC index", () => {
    // Was `tau_banking` on a 0-1 scale; the free tier publishes only composites
    // since the API migration, and the composite is on ~0-100.
    const snapshot = snapshotOf([
      row({
        aaMetrics: {
          intelligenceIndex: 51.8,
          codingIndex: 69.1,
          agenticIndex: 48.4,
        },
      }),
    ]);
    expect(snapshot.metrics[KEY]?.toolUse).toBe(48.4);
    expect(snapshot.metrics[KEY]?.coding).toBe(69.1);
    expect(snapshot.metrics[KEY]?.intelligence).toBe(51.8);
  });

  test("a model with no live grades is reported as PARTIAL and falls back", () => {
    const snapshot = snapshotOf([row({ aaMetrics: null })]);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.metrics[KEY]?.intelligence).toBe(
      FALLBACK_METRICS[KEY]?.intelligence ?? null,
    );
    // Secondary axes keep no fallback: an honest blank costs the reader nothing.
    expect(snapshot.metrics[KEY]?.coding).toBeNull();
    expect(snapshot.metrics[KEY]?.toolUse).toBeNull();
  });

  test("rows with no grades yield the pure-fallback snapshot, never a crash", () => {
    // What `get.ts` serves on a cold metrics cache. The registry is the rows
    // now, so "no models described" and "no grades for the models described"
    // are different states: the first renders an empty hub, the second renders
    // every card on fallback numbers, which is the one worth pinning.
    setLiveStateDouble(BOUND_ROWS);
    const snapshot = buildModelMetricsSnapshot([]);
    expect(Object.keys(snapshot.metrics).length).toBe(BOUND_ROWS.length);
    expect(snapshot.partial).toBe(true);
    for (const [key, metric] of Object.entries(snapshot.metrics)) {
      // The three headline gauges must always render.
      expect(`${key}:${metric.intelligence !== null}`).toBe(`${key}:true`);
      expect(`${key}:${metric.speed !== null}`).toBe(`${key}:true`);
      expect(`${key}:${metric.timeToFirstAnswer !== null}`).toBe(`${key}:true`);
    }
  });

  test("time to first ANSWER still comes from Artificial Analysis", () => {
    // The one axis no endpoint API can produce: they time the first token of any
    // kind and cannot see where reasoning ends.
    const snapshot = snapshotOf([
      row({
        aaMetrics: { timeToFirstAnswerTokenSeconds: 41.29 },
        endpointStats: [
          endpoint({
            provider: "fast",
            throughputP50: 51,
            latencyP50Ms: 2_440,
          }),
        ],
      }),
    ]);
    // 2.44 s to the first token of any kind, 41.29 s to the first ANSWER token:
    // the gap IS the reasoning, and collapsing the two would hide the wait.
    expect(snapshot.metrics[KEY]?.ttftSeconds).toBe(2.44);
    expect(snapshot.metrics[KEY]?.timeToFirstAnswer).toBe(41.29);
  });
});

describe("cost", () => {
  test("a fresher price outranks the one on the warmed snapshot", () => {
    // The override exists for a caller holding a row newer than the snapshot
    // the registry was warmed with — a price measured minutes ago beats one
    // memoised at boot.
    setLiveStateDouble(BOUND_ROWS);
    const profile = boundProfile(KEY);
    const dear = { inputPerMTok: 40, outputPerMTok: 120 };
    const snapshot = buildModelMetricsSnapshot([
      row({ profileKey: KEY, pricing: dear }),
    ]);
    expect(snapshot.metrics[KEY]?.costLevel).toBe(
      costLevelFromProfile(profile, dear),
    );
    // And it genuinely differs from the row's own price, or the case proves
    // nothing about which one was used.
    expect(snapshot.metrics[KEY]?.costLevel).not.toBe(
      costLevelFromProfile(profile),
    );
  });

  test("with no fresher row, the profile's own price prices the card", () => {
    setLiveStateDouble(BOUND_ROWS);
    const profile = boundProfile(KEY);
    const snapshot = buildModelMetricsSnapshot([]);
    expect(snapshot.metrics[KEY]?.costLevel).toBe(
      costLevelFromProfile(profile),
    );
  });
});

describe("costRatio", () => {
  /**
   * The multiple `costLevel` deliberately cannot express. Log scaling is what
   * keeps a hundredfold price range legible on one gauge, and it is also what
   * makes "how much more does this one cost me" unanswerable from the gauge —
   * the same three-point gap is 10 % at one end of the fleet and 2× at the
   * other. So the ratio is carried, and the dollars it derives from are not.
   */
  test("a TYPICAL model is the unit, so the scale reads both ways", () => {
    // Anchored on the median, never the cheapest. Measured on the real fleet
    // (2026-08-31), the floor is a near-free model, and against it the MEDIAN
    // model reads "29.6×" and the dearest "2771×" — true, and unusable. The
    // fixture below reproduces that shape: one very cheap row, one very dear
    // one, and a body of ordinary ones.
    setLiveStateDouble(BOUND_ROWS);
    const snapshot = buildModelMetricsSnapshot([
      row({
        profileKey: KEY,
        pricing: { inputPerMTok: 0.01, outputPerMTok: 0.04 },
      }),
    ]);
    const ratios = Object.values(snapshot.metrics)
      .map((metric) => metric.costRatio)
      .filter((ratio): ratio is number => ratio !== null);
    expect(ratios.length).toBeGreaterThan(1);
    // The near-free model sits well below one; nothing is pinned at the floor.
    expect(snapshot.metrics[KEY]?.costRatio).toBeLessThan(0.5);
    expect(Math.min(...ratios)).toBeLessThan(1);
    expect(Math.max(...ratios)).toBeGreaterThanOrEqual(1);
  });

  test("a cheap model keeps two decimals rather than rounding to nothing", () => {
    // At one decimal a model a fiftieth of typical reads "0", which says the
    // opposite of what it costs.
    setLiveStateDouble(BOUND_ROWS);
    const ratio = buildModelMetricsSnapshot([
      row({
        profileKey: KEY,
        pricing: { inputPerMTok: 0.002, outputPerMTok: 0.008 },
      }),
    ]).metrics[KEY]?.costRatio;
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeGreaterThan(0);
  });

  test("moves with the price, where costLevel's log scale flattens it", () => {
    setLiveStateDouble(BOUND_ROWS);
    const cheap = buildModelMetricsSnapshot([
      row({ profileKey: KEY, pricing: { inputPerMTok: 1, outputPerMTok: 4 } }),
    ]).metrics[KEY]?.costRatio;
    const dear = buildModelMetricsSnapshot([
      row({
        profileKey: KEY,
        pricing: { inputPerMTok: 40, outputPerMTok: 120 },
      }),
    ]).metrics[KEY]?.costRatio;
    expect(cheap).not.toBeNull();
    expect(dear).not.toBeNull();
    expect(dear ?? 0).toBeGreaterThan(cheap ?? 0);
  });

  test("a free model never makes every sibling's ratio infinite", () => {
    // A zero price is excluded from the ANCHOR rather than folded in: a median
    // dragged to zero would report the whole fleet as infinitely expensive.
    setLiveStateDouble(BOUND_ROWS);
    const snapshot = buildModelMetricsSnapshot([
      row({ profileKey: KEY, pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
    ]);
    expect(snapshot.metrics[KEY]?.costRatio).toBeNull();
    for (const metric of Object.values(snapshot.metrics)) {
      if (metric.costRatio !== null) expect(metric.costRatio).toBeFinite();
    }
  });
});
