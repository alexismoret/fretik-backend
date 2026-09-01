import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CANDIDATE_POLICY,
  PUBLISHED_POLICY,
  computeHealthScore,
  evaluatePolicy,
} from "../../src/model-registry/policy";
import type { EndpointStat } from "../../src/model-registry/types";
import {
  STAT_CARRY_MAX_DAYS,
  carryForwardMeasurements,
  unionEndpointStats,
} from "../../src/services/model-registry/sync/compute";
import {
  type ModelSyncStats,
  syncVerdict,
} from "../../src/services/model-registry/sync/run";

/**
 * The measurement half of the sync, and the defect it was written for.
 *
 * On 2026-09-01 the nightly pass ran in a container holding none of the three
 * API keys the grading needs. OpenRouter answers 200 with every percentile
 * `null` when unauthenticated, so every published endpoint lost its throughput
 * and latency — 0 of 145, twice, reproducibly — while the run reported `ok`,
 * 47 of 47 rows updated, zero errors.
 *
 * Three separate mechanisms had to fail together for that to be silent, and
 * this file pins all three:
 *
 * 1. A rule with no data VANISHED from the report instead of failing, so
 *    "we did not check" rendered exactly like "everything passed" — the
 *    throughput floor whose docstring argues hardest for its number had never
 *    once run against the fleet.
 * 2. A vanished rule took its penalty with it, so LOSING a measurement made
 *    the health score go UP.
 * 3. Nothing carried a measurement forward, so one bad pass blanked figures
 *    that had been correct the night before.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 200_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
  hasZdr: true,
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

const ruleFor = (
  name: string,
  endpoints: EndpointStat[],
  sourcePublishes?: { percentiles?: boolean; uptime?: boolean },
) =>
  evaluatePolicy(
    PUBLISHED_POLICY,
    {
      endpoints,
      excludedProviders: [],
      requiresTools: true,
      ...(sourcePublishes === undefined ? {} : { sourcePublishes }),
    },
    new Date(),
  ).rules.find((rule) => rule.rule === name);

describe("a rule the policy sets is never absent", () => {
  test("the throughput floor reports SKIPPED rather than disappearing", () => {
    // The exact production shape: endpoints that are otherwise complete and
    // carry no percentiles at all.
    const rule = ruleFor("throughput-floor", [endpoint({ provider: "a" })]);
    expect(rule).toBeDefined();
    expect(rule?.skipped).toBe("not-measured");
    // Neither a pass nor a failure: absence of evidence is not evidence of
    // failure, and letting it fail would let one dead credential unpublish
    // the fleet.
    expect(rule?.passed).toBe(false);
  });

  test("a skipped rule counts in NEITHER failure tally", () => {
    const report = evaluatePolicy(
      PUBLISHED_POLICY,
      {
        endpoints: [endpoint({ provider: "a" })],
        excludedProviders: [],
        requiresTools: true,
      },
      new Date(),
    );
    expect(report.skippedRules).toBeGreaterThan(0);
    // `passed` is decided by hard failures alone, so a fleet that lost its
    // measurements must stay published.
    expect(report.passed).toBe(true);
    expect(report.hardFailures).toBe(0);
  });

  test("a structural gap is named differently from a repairable one", () => {
    // Scaleway publishes no percentiles at all and never will; OpenRouter
    // publishes them behind a key. Only the second is somebody's problem
    // tonight, and the report has to say which one this is.
    expect(
      ruleFor("throughput-floor", [endpoint({ provider: "a" })], {
        percentiles: false,
      })?.skipped,
    ).toBe("not-published-by-source");
    expect(
      ruleFor("throughput-floor", [endpoint({ provider: "a" })], {
        percentiles: true,
      })?.skipped,
    ).toBe("not-measured");
  });

  test("an unknown source capability reads as repairable", () => {
    // The conservative default: a wiring gap should be investigated, not
    // shrugged off as a property of the transport.
    expect(
      ruleFor("uptime-floor", [endpoint({ provider: "a" })])?.skipped,
    ).toBe("not-measured");
  });

  test("the TTFT ceiling falls back to p90 and says so", () => {
    // OpenRouter's percentile objects carry p90 and no p95, so mapping
    // nothing left this rule permanently unevaluable for every OpenRouter row
    // — a ceiling nobody could ever fail. A near neighbour under its own name
    // is evidence; the same number wearing `p95` would be a fake.
    const rule = evaluatePolicy(
      DEFAULT_CANDIDATE_POLICY,
      {
        endpoints: [endpoint({ provider: "a", latencyP90Ms: 900 })],
        excludedProviders: [],
        requiresTools: true,
      },
      new Date(),
    ).rules.find((r) => r.rule === "ttft-ceiling");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("p90");
  });

  test("a real p95 is preferred over a p90 when both exist", () => {
    const rule = evaluatePolicy(
      DEFAULT_CANDIDATE_POLICY,
      {
        endpoints: [
          endpoint({ provider: "a", latencyP90Ms: 900, latencyP95Ms: 1500 }),
        ],
        excludedProviders: [],
        requiresTools: true,
      },
      new Date(),
    ).rules.find((r) => r.rule === "ttft-ceiling");
    expect(rule?.detail).toContain("p95");
    expect(rule?.detail).toContain("1500");
  });
});

describe("losing a measurement never improves the score", () => {
  const graded = (endpoints: EndpointStat[]): number =>
    computeHealthScore({
      endpoints,
      report: evaluatePolicy(
        PUBLISHED_POLICY,
        { endpoints, excludedProviders: [], requiresTools: true },
        new Date(),
      ),
      incidents24h: 0,
    });

  test("a pool that lost its percentiles scores no higher than one that kept them", () => {
    // The inversion this pins: before skips existed, dropping the throughput
    // removed the rule AND its penalty, so an unmeasured fleet graded
    // healthier than a measured one — the score rose as the evidence
    // disappeared.
    const measured = endpoint({
      provider: "a",
      uptime1d: 99,
      throughputP50: 120,
    });
    const blanked = endpoint({ provider: "a", uptime1d: 99 });
    expect(graded([blanked])).toBeLessThanOrEqual(graded([measured]));
  });

  test("a passing measurement still beats a missing one", () => {
    const fast = endpoint({ provider: "a", uptime1d: 99, throughputP50: 120 });
    const missing = endpoint({ provider: "a", uptime1d: 99 });
    expect(graded([fast])).toBeGreaterThan(graded([missing]));
  });
});

describe("carryForwardMeasurements", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const daysAgo = (days: number): string =>
    new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  test("a fresh measurement wins over a stored one", () => {
    const { endpoints, carriedForward } = carryForwardMeasurements(
      [endpoint({ provider: "a", throughputP50: 120, measuredAt: daysAgo(0) })],
      [endpoint({ provider: "a", throughputP50: 40, measuredAt: daysAgo(1) })],
      now,
    );
    expect(endpoints[0]?.throughputP50).toBe(120);
    expect(carriedForward).toBe(0);
  });

  test("a missing measurement keeps the stored one, within the window", () => {
    const { endpoints, carriedForward } = carryForwardMeasurements(
      [endpoint({ provider: "a" })],
      [endpoint({ provider: "a", throughputP50: 40, measuredAt: daysAgo(1) })],
      now,
    );
    expect(endpoints[0]?.throughputP50).toBe(40);
    // The stamp travels with the kept figure, so its age stays legible rather
    // than being refreshed into looking current.
    expect(endpoints[0]?.measuredAt).toBe(daysAgo(1));
    expect(carriedForward).toBe(1);
  });

  test("a fossil past the window falls rather than being carried", () => {
    const { endpoints, carriedForward } = carryForwardMeasurements(
      [endpoint({ provider: "a" })],
      [
        endpoint({
          provider: "a",
          throughputP50: 40,
          measuredAt: daysAgo(STAT_CARRY_MAX_DAYS + 1),
        }),
      ],
      now,
    );
    expect(endpoints[0]?.throughputP50).toBeUndefined();
    expect(carriedForward).toBe(0);
  });

  test("a stored stat with no stamp is never carried", () => {
    // Rows graded before `measuredAt` existed: their age is unknowable, and a
    // figure of unknowable age is what this function exists to stop writing.
    const { endpoints } = carryForwardMeasurements(
      [endpoint({ provider: "a" })],
      [endpoint({ provider: "a", throughputP50: 40 })],
      now,
    );
    expect(endpoints[0]?.throughputP50).toBeUndefined();
  });

  test("carrying is per FIELD, not per endpoint", () => {
    // A host that reported its uptime but not its throughput keeps only the
    // half it could not re-observe.
    const { endpoints } = carryForwardMeasurements(
      [endpoint({ provider: "a", uptime1d: 97, measuredAt: daysAgo(0) })],
      [
        endpoint({
          provider: "a",
          uptime1d: 99,
          throughputP50: 40,
          measuredAt: daysAgo(1),
        }),
      ],
      now,
    );
    expect(endpoints[0]?.uptime1d).toBe(97);
    expect(endpoints[0]?.throughputP50).toBe(40);
    // It measured something itself, so it keeps ITS stamp — mixing in the
    // older date would age fresh evidence.
    expect(endpoints[0]?.measuredAt).toBe(daysAgo(0));
  });

  test("an endpoint that no longer exists upstream is not resurrected", () => {
    // Carrying is about FIELDS on endpoints the fetch returned. A host that
    // dropped off the pool must not come back because we remember it.
    const { endpoints } = carryForwardMeasurements(
      [endpoint({ provider: "a" })],
      [
        endpoint({
          provider: "gone",
          throughputP50: 40,
          measuredAt: daysAgo(1),
        }),
      ],
      now,
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.provider).toBe("a");
  });
});

describe("syncVerdict", () => {
  const stats = (over: Partial<ModelSyncStats> = {}): ModelSyncStats => ({
    modelsSeen: 47,
    modelsUpdated: 47,
    candidatesAdded: 0,
    policyFailures: 0,
    quarantinesReleased: 0,
    alerts: 0,
    errors: [],
    missingCapabilities: [],
    endpointsWritten: 145,
    endpointsExpectingPercentiles: 145,
    endpointsWithThroughput: 145,
    endpointsCarriedForward: 0,
    rulesSkippedNotMeasured: 0,
    ...over,
  });

  test("a fully measured pass is ok", () => {
    expect(syncVerdict(stats())).toBe("ok");
  });

  test("a missing credential is degraded, not ok", () => {
    // The production shape verbatim: every model seen, every row updated, zero
    // errors — and no key, so nothing was actually measured. This reported
    // `ok` for days.
    expect(
      syncVerdict(
        stats({
          missingCapabilities: ["openrouter-percentiles"],
          endpointsWithThroughput: 0,
        }),
      ),
    ).toBe("degraded");
  });

  test("a key that is present but rejected is still caught", () => {
    // A revoked or rate-limited key returns byte-for-byte what a missing one
    // returns, so the presence check alone cannot see it. The ratio can.
    expect(syncVerdict(stats({ endpointsWithThroughput: 0 }))).toBe("degraded");
  });

  test("idle hosts do not trip the ratio", () => {
    // Hosts with no recent traffic legitimately report nothing. The floor is a
    // smoke alarm for a fleet-wide blackout, not a quality bar per model.
    expect(syncVerdict(stats({ endpointsWithThroughput: 100 }))).toBe("ok");
  });

  test("an error outranks a degradation", () => {
    // `partial` says a model failed to refresh, which is the more actionable
    // fact; the degradation is still in the stats and its alert still fires.
    expect(
      syncVerdict(
        stats({
          errors: ["deepseek-v4-flash: timeout"],
          missingCapabilities: ["artificial-analysis"],
        }),
      ),
    ).toBe("partial");
  });

  test("a fleet whose sources publish no percentiles is not degraded", () => {
    // Scaleway-only: there is nothing to measure, so measuring nothing is
    // correct and must not raise an alarm every night forever.
    expect(
      syncVerdict(
        stats({
          endpointsExpectingPercentiles: 0,
          endpointsWithThroughput: 0,
        }),
      ),
    ).toBe("ok");
  });
});

describe("unionEndpointStats", () => {
  test("keeps hosts that exist only in the second list", () => {
    // The accumulator bug: `mergeEndpointStats` maps over its primary, so
    // folding each fetch into an empty accumulator returned `[]` every time
    // and the cross-transport enrichment loop was dead from the day it was
    // written — invisibly, because an empty enrichment merges into an
    // unchanged primary.
    const accumulated = unionEndpointStats(
      [],
      [endpoint({ provider: "a", quantization: "fp8" })],
    );
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]?.quantization).toBe("fp8");
  });

  test("the first list wins a collision, field by field", () => {
    const merged = unionEndpointStats(
      [endpoint({ provider: "a", throughputP50: 120 })],
      [endpoint({ provider: "a", throughputP50: 40, quantization: "fp8" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.throughputP50).toBe(120);
    // …while still gaining what only the second one knows.
    expect(merged[0]?.quantization).toBe("fp8");
  });

  test("accumulating three sources keeps all three hosts", () => {
    const one = unionEndpointStats([], [endpoint({ provider: "a" })]);
    const two = unionEndpointStats(one, [endpoint({ provider: "b" })]);
    const three = unionEndpointStats(two, [endpoint({ provider: "c" })]);
    expect(three.map((stat) => stat.provider).sort()).toEqual(["a", "b", "c"]);
  });
});
