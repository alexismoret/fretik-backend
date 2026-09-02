import { describe, expect, test } from "bun:test";
import type {
  LiveModelState,
  QuarantineEntry,
} from "../../src/model-registry/types";
import {
  activeQuarantines,
  effectivePoolFor,
  quarantineChanged,
} from "../../src/services/model-registry/breaker";

/**
 * What routing SEES, derived from a live-state row and a clock.
 *
 * Three pure functions over a plain object. They used to sit at the bottom of
 * the breaker's write suite behind a faked `db`, which cost them nothing but
 * hid what they are: the half of the module that has no side effects at all
 * and needs no database to be believed. The write ladder they belong to is now
 * exercised against Postgres in `tests/integration/model-registry/breaker.test.ts`.
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");

const state = (overrides: Partial<LiveModelState> = {}): LiveModelState => ({
  profileKey: "acme-m1",
  status: "published",
  transport: "gateway",
  enabled: true,
  disabledReason: null,
  modelIds: { gateway: "acme/m1" },
  providerPool: {},
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 128_000,
  effectiveMaxOutput: 8_192,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  creditMultiplier: 1,
  health: "healthy",
  healthScore: 90,
  policyReport: null,
  endpointStats: [],
  aaMetrics: null,
  releasedAt: null,
  aaSlug: null,
  dynamicProfile: null,
  boundRoles: [],
  source: "sync",
  syncedAt: new Date("2026-08-01"),
  ...overrides,
});

/** A quarantine still in force at NOW. */
const entry = (provider: string): QuarantineEntry => ({
  provider,
  transport: "gateway",
  kind: "upstream-cut",
  quarantinedAt: "2026-08-30T12:00:00.000Z",
  releaseAt: "2026-09-06T12:00:00.000Z",
  incidentIds: [],
  reason: "prior",
});

describe("activeQuarantines", () => {
  test("excludes expired entries", () => {
    const row = state({
      quarantinedProviders: [
        entry("alpha"),
        { ...entry("beta"), releaseAt: "2026-08-01T00:00:00.000Z" },
      ],
    });

    expect(activeQuarantines(row, NOW).map((e) => e.provider)).toEqual([
      "alpha",
    ]);
  });
});

describe("effectivePoolFor", () => {
  test("narrows `only` and always carries quarantines in `ignore`", () => {
    const row = state({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      quarantinedProviders: [entry("alpha")],
    });

    expect(effectivePoolFor(row, "gateway", NOW)).toEqual({
      only: ["beta"],
      ignore: ["alpha"],
    });
  });

  test("a widened pool drops `only` but still ignores the bad host", () => {
    // This is the distinction `list` prints as "open": no `only` on the wire,
    // so routing is open MINUS the quarantines — never back onto them.
    const row = state({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      quarantinedProviders: [entry("alpha")],
      poolWidened: true,
    });

    expect(effectivePoolFor(row, "gateway", NOW)).toEqual({
      ignore: ["alpha"],
    });
  });
});

describe("quarantineChanged", () => {
  test("says false about the rung that writes but removes nothing", () => {
    // Rung 4 WRITES (`lastResort`, `health: "failing"`) and the old boolean
    // return said `false` for it — read by every caller as "nothing happened".
    // The predicate now speaks only about the POOL, which is the distinction
    // the boolean collapsed.
    expect(quarantineChanged({ kind: "last-resort" })).toBe(false);
  });
});
