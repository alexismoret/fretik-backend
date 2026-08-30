import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import { costLevelFromProfile } from "../../../src/services/model-metrics/cost-level";
import { FALLBACK_METRICS } from "../../../src/services/model-metrics/fallback";
import { buildModelMetricsSnapshot } from "../../../src/services/model-metrics/refresh";

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
  dynamicProfile: null,
  boundRoles: [],
  source: "sync",
  syncedAt: new Date(),
  ...over,
});

describe("which endpoint describes the model", () => {
  test("speed is the FASTEST endpoint in the pool, not the median", () => {
    // Every pool routes with `sort: "throughput"`, so the fastest reachable
    // endpoint serves unless it is down. A median would describe a route the
    // model reaches only when its best host is unavailable.
    const snapshot = buildModelMetricsSnapshot([
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
    const snapshot = buildModelMetricsSnapshot([
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
    const snapshot = buildModelMetricsSnapshot([
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
    const snapshot = buildModelMetricsSnapshot([
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
    const snapshot = buildModelMetricsSnapshot([
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
    const snapshot = buildModelMetricsSnapshot([row({ aaMetrics: null })]);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.metrics[KEY]?.intelligence).toBe(
      FALLBACK_METRICS[KEY]?.intelligence ?? null,
    );
    // Secondary axes keep no fallback: an honest blank costs the reader nothing.
    expect(snapshot.metrics[KEY]?.coding).toBeNull();
    expect(snapshot.metrics[KEY]?.toolUse).toBeNull();
  });

  test("an empty database yields the pure-fallback snapshot, never a crash", () => {
    // What `get.ts` serves on a cold cache, and what a fresh environment shows.
    const snapshot = buildModelMetricsSnapshot([]);
    expect(Object.keys(snapshot.metrics).length).toBe(
      Object.keys(MODEL_PROFILES).length,
    );
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
    const snapshot = buildModelMetricsSnapshot([
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
  test("the measured pool price outranks the curated one", () => {
    const profile = MODEL_PROFILES[KEY];
    if (profile === undefined) throw new Error(`no profile for ${KEY}`);
    const dear = { inputPerMTok: 40, outputPerMTok: 120 };
    const snapshot = buildModelMetricsSnapshot([row({ pricing: dear })]);
    expect(snapshot.metrics[KEY]?.costLevel).toBe(
      costLevelFromProfile(profile, dear),
    );
    // And it genuinely differs from the curated baseline, or the case proves
    // nothing about which one was used.
    expect(snapshot.metrics[KEY]?.costLevel).not.toBe(
      costLevelFromProfile(profile),
    );
  });

  test("with no live row, the curated price still prices the card", () => {
    const profile = MODEL_PROFILES[KEY];
    if (profile === undefined) throw new Error(`no profile for ${KEY}`);
    const snapshot = buildModelMetricsSnapshot([]);
    expect(snapshot.metrics[KEY]?.costLevel).toBe(
      costLevelFromProfile(profile),
    );
  });
});
