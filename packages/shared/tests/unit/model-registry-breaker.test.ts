import { beforeEach, describe, expect, test } from "bun:test";
import type {
  EndpointStat,
  LiveModelState,
  ModelWriteActor,
  QuarantineEntry,
} from "../../src/model-registry/types";
import { mockModule } from "./mock-module";

/**
 * The escalation ladder, CHARACTERISED — including the lie in its return type.
 *
 * `quarantineProvider` documents itself as "returns whether anything changed",
 * and for three of its four rungs that holds. Rung 4 WRITES (`lastResort:
 * true`, `health: "failing"`) and returns `false` anyway, so the boolean
 * actually means "was the provider removed from the pool", which is not what
 * any caller reads it as. The CLI recovers the difference by re-reading the row
 * and fuzzy-matching the provider name with `.includes()`.
 *
 * That is why these tests exist before the refactor that gives both writes a
 * discriminated outcome: the ladder has four branches, two `false` exits, and
 * exactly one automated exercise anywhere (`ai/evals/transport-smoke.ts`).
 *
 * The rung is chosen by two counts, so each fixture below is built to force
 * one branch:
 *   vetted = members of `providerPool[transport].only` left once the target
 *            goes (undefined when the pool is widened or has no `only`)
 *   clean  = distinct providers in `endpointStats` left once the target goes
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");
/** 7 days on from NOW — `QUARANTINE_DAYS`, restated so the test can assert it. */
const RELEASE_AT = "2026-09-07T12:00:00.000Z";

const endpoint = (provider: string): EndpointStat => ({
  provider,
  displayName: provider,
  wireNames: { gateway: provider },
  contextLength: 128_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
});

const fakeState = (
  overrides: Partial<LiveModelState> = {},
): LiveModelState => ({
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
  endpointStats: [endpoint("alpha"), endpoint("beta")],
  aaMetrics: null,
  releasedAt: null,
  aaSlug: null,
  dynamicProfile: null,
  boundRoles: [],
  source: "sync",
  syncedAt: new Date("2026-08-01"),
  ...overrides,
});

/** A quarantine already in force at NOW. */
const activeEntry = (provider: string): QuarantineEntry => ({
  provider,
  transport: "gateway",
  kind: "upstream-cut",
  quarantinedAt: "2026-08-30T12:00:00.000Z",
  releaseAt: "2026-09-06T12:00:00.000Z",
  incidentIds: [],
  reason: "prior",
});

let storedState: LiveModelState | undefined;
const updates: Record<string, unknown>[] = [];
let invalidations = 0;
const alerts: { kind: string; severity: string; message: string }[] = [];

/**
 * Both writes decide and commit inside `db.transaction`, so the fake has to
 * offer one. The callback receives the same builder the outer fake exposes —
 * enough, because the locked READ goes through `readLiveStateRowForUpdate`,
 * which is mocked below alongside its unlocked sibling.
 */
/** Set to make the row write reject, standing in for a rolled-back commit. */
let failWrite = false;

const builder = {
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return {
        where: () =>
          failWrite
            ? Promise.reject(new Error("write failed"))
            : Promise.resolve(undefined),
      };
    },
  }),
};

/**
 * Re-installed before EVERY test — see the same helper in
 * `model-registry-admin.test.ts` for why.
 *
 * Short version: `mock.module` is process-wide and lands at LOAD time while
 * tests run afterwards, so the last of the eleven suites faking `../../src/db`
 * to be loaded wins for the whole process. That is `readdir` order — stable and
 * benign on APFS, different on ext4 — and it failed all 12 tests here on CI
 * while passing locally every time.
 */
const installMocks = async (): Promise<void> => {
  await mockModule("../../src/db", {
    default: {
      ...builder,
      transaction: <T>(fn: (tx: typeof builder) => Promise<T>) => fn(builder),
    },
  });

  await mockModule("../../src/services/model-registry/live", {
    readLiveStateRow: (profileKey: string) =>
      Promise.resolve(
        storedState?.profileKey === profileKey ? storedState : undefined,
      ),
    readLiveStateRowForUpdate: (_tx: unknown, profileKey: string) =>
      Promise.resolve(
        storedState?.profileKey === profileKey ? storedState : undefined,
      ),
    invalidateLiveRegistry: () => {
      invalidations += 1;
      return Promise.resolve();
    },
  });

  await mockModule("../../src/services/model-registry/alerts", {
    raiseModelAlert: (input: {
      kind: string;
      severity: string;
      message: string;
    }) => {
      alerts.push({
        kind: input.kind,
        severity: input.severity,
        message: input.message,
      });
      return Promise.resolve();
    },
  });
};

await installMocks();

const {
  activeQuarantines,
  effectivePoolFor,
  quarantineChanged,
  quarantineProvider,
  releaseProvider,
} = await import("../../src/services/model-registry/breaker");

const quarantine = (
  state: LiveModelState,
  actor: ModelWriteActor = { kind: "cli" },
) => {
  storedState = state;
  return quarantineProvider({
    modelKey: "acme-m1",
    provider: "alpha",
    transport: "gateway",
    kind: "upstream-cut",
    reason: "test",
    actor,
    now: NOW,
  });
};

/** The entry every writing rung records for `alpha` at NOW. */
const expectedEntry: QuarantineEntry = {
  provider: "alpha",
  transport: "gateway",
  kind: "upstream-cut",
  quarantinedAt: NOW.toISOString(),
  releaseAt: RELEASE_AT,
  incidentIds: [],
  reason: "test",
};

beforeEach(async () => {
  updates.length = 0;
  alerts.length = 0;
  invalidations = 0;
  failWrite = false;
  storedState = fakeState();
  await installMocks();
});

describe("quarantineProvider — the ladder", () => {
  test("rung 1: vetted members left → plain quarantine", async () => {
    const outcome = await quarantine(
      fakeState({ providerPool: { gateway: { only: ["alpha", "beta"] } } }),
    );

    expect(outcome).toEqual({
      kind: "quarantined",
      entry: expectedEntry,
      remaining: 1,
      remainingSource: "vetted",
    });
    // Only the quarantine list moves: no widening, no transport change.
    expect(updates[0]).toEqual({
      quarantinedProviders: [expectedEntry],
      source: "admin",
    });
    expect(alerts[0]).toMatchObject({
      kind: "quarantine",
      severity: "critical",
    });
    expect(alerts[0]?.message).toContain("1 upstream(s) left");
    expect(invalidations).toBe(1);
  });

  test("rung 1 counts live endpoints when there is no vetted pool", async () => {
    // `vetted` is undefined here, so the ladder falls back to counting live
    // endpoints — two hosts on record, one left once alpha goes. The outcome
    // says WHICH count it used, so an operator reading "1 left" knows whether
    // that is one vetted host or one unmeasured one.
    const outcome = await quarantine(fakeState());

    expect(outcome).toMatchObject({
      kind: "quarantined",
      remaining: 1,
      remainingSource: "endpoints",
    });
    expect(updates[0]).not.toHaveProperty("poolWidened");
  });

  test("rung 2: vetted pool exhausted but the transport has other hosts → widen", async () => {
    const outcome = await quarantine(
      fakeState({ providerPool: { gateway: { only: ["alpha"] } } }),
    );

    expect(outcome).toEqual({
      kind: "pool-widened",
      entry: expectedEntry,
      remaining: 1,
    });
    expect(updates[0]).toMatchObject({ poolWidened: true });
    expect(alerts[0]?.message).toContain("last VETTED upstream");
    // An unmeasured upstream is a risk; a measured-bad one is a certainty.
    expect(alerts[0]?.message).toContain("OPEN");
  });

  test("rung 3: nothing clean here, the model exists elsewhere → switch transport", async () => {
    const outcome = await quarantine(
      fakeState({
        modelIds: { gateway: "acme/m1", openrouter: "acme/m-1" },
        providerPool: { gateway: { only: ["alpha"] } },
        endpointStats: [endpoint("alpha")],
      }),
    );

    expect(outcome).toEqual({
      kind: "transport-switched",
      entry: expectedEntry,
      from: "gateway",
      to: "openrouter",
    });
    expect(updates[0]).toMatchObject({
      transport: "openrouter",
      poolWidened: false,
    });
    expect(alerts[0]?.message).toContain("SWITCHED to openrouter");
  });

  test("rung 4: nothing anywhere → stays in service, marked last resort", async () => {
    const outcome = await quarantine(
      fakeState({
        providerPool: { gateway: { only: ["alpha"] } },
        endpointStats: [endpoint("alpha")],
      }),
    );

    // This rung WRITES and used to return `false`, i.e. "nothing changed" for
    // the single most serious branch. It is now its own outcome, and
    // `quarantineChanged` says false only about the POOL — which is the
    // distinction the boolean collapsed.
    expect(outcome).toEqual({ kind: "last-resort" });
    expect(quarantineChanged(outcome)).toBe(false);
    expect(updates[0]).toEqual({
      lastResort: true,
      health: "failing",
      source: "admin",
    });
    // Note what is NOT written: the quarantine entry itself is discarded.
    expect(updates[0]).not.toHaveProperty("quarantinedProviders");
    expect(alerts[0]).toMatchObject({
      kind: "quarantine-skipped",
      severity: "critical",
    });
    expect(invalidations).toBe(1);
  });

  test("a failed write announces nothing", async () => {
    // The reason the alert and the cache drop sit OUTSIDE the transaction: an
    // alert about a write that rolled back is a lie, and invalidating before
    // the commit tells every replica to reload the row that is about to stay
    // exactly as it was.
    failWrite = true;

    expect(
      quarantine(
        fakeState({ providerPool: { gateway: { only: ["alpha", "beta"] } } }),
      ),
    ).rejects.toThrow(/write failed/);

    expect(alerts).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("the actor decides the provenance stamp", async () => {
    // The same function serves a runtime detector and a person, and it used to
    // record `admin` for both — a column that could not tell a machine from a
    // human, invisible until a screen puts a name beside the word.
    await quarantine(
      fakeState({ providerPool: { gateway: { only: ["alpha", "beta"] } } }),
      { kind: "breaker" },
    );
    expect(updates[0]).toMatchObject({ source: "breaker" });

    updates.length = 0;
    await quarantine(
      fakeState({ providerPool: { gateway: { only: ["alpha", "beta"] } } }),
      { kind: "operator", userId: "user-1" },
    );
    // A person is a person whichever door they came through: WHO exactly
    // belongs in the action log, not in this column.
    expect(updates[0]).toMatchObject({ source: "admin" });
  });
});

describe("quarantineProvider — the two exits that really are no-ops", () => {
  test("already quarantined: reports the standing entry, writes nothing", async () => {
    const standing = activeEntry("alpha");
    const outcome = await quarantine(
      fakeState({ quarantinedProviders: [standing] }),
    );

    // The ENTRY comes back, so the caller can say "until when" without
    // re-reading the row and guessing which quarantine is the right one.
    expect(outcome).toEqual({ kind: "already-quarantined", entry: standing });
    expect(updates).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("an EXPIRED quarantine does not count as already quarantined", async () => {
    const outcome = await quarantine(
      fakeState({
        quarantinedProviders: [
          { ...activeEntry("alpha"), releaseAt: "2026-08-01T00:00:00.000Z" },
        ],
      }),
    );

    expect(outcome.kind).toBe("quarantined");
    // The expired row is dropped rather than kept: the column holds current
    // state, the incidents table is the history.
    expect(updates[0]?.quarantinedProviders).toHaveLength(1);
  });

  test("no live row: records the finding and stops", async () => {
    storedState = undefined;

    const outcome = await quarantineProvider({
      modelKey: "ghost",
      provider: "alpha",
      transport: "gateway",
      kind: "upstream-cut",
      reason: "test",
      actor: { kind: "cli" },
      now: NOW,
    });

    // Distinct from "already quarantined", which the old boolean could not
    // say: one means the pool is already protected, the other that there is
    // no pool at all.
    expect(outcome).toEqual({ kind: "no-live-row" });
    expect(updates).toHaveLength(0);
    expect(alerts[0]).toMatchObject({
      kind: "quarantine-skipped",
      severity: "warning",
    });
  });
});

describe("releaseProvider", () => {
  test("restores the host, re-narrows routing and lifts last resort", async () => {
    const standing = activeEntry("alpha");
    storedState = fakeState({
      quarantinedProviders: [standing],
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      poolWidened: true,
      lastResort: true,
    });

    const outcome = await releaseProvider({
      modelKey: "acme-m1",
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "sync" },
    });

    expect(outcome).toEqual({
      kind: "released",
      entry: standing,
      poolRenarrowed: true,
      lastResortLifted: true,
    });
    expect(updates[0]).toEqual({
      quarantinedProviders: [],
      poolWidened: false,
      lastResort: false,
      // This write recorded no provenance at all until 2026-08-31, alone among
      // its siblings.
      source: "sync",
    });
    expect(alerts[0]).toMatchObject({ kind: "release" });
    expect(invalidations).toBe(1);
  });

  test("a provider that was not quarantined names where it IS quarantined", async () => {
    const onOther: QuarantineEntry = {
      ...activeEntry("alpha"),
      transport: "openrouter",
    };
    storedState = fakeState({
      quarantinedProviders: [activeEntry("beta"), onOther],
    });

    const outcome = await releaseProvider({
      modelKey: "acme-m1",
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "cli" },
    });

    // Quarantine is recorded PER TRANSPORT, and this function is the only
    // place that knows it. It used to return `void`, so the caller re-read the
    // row and diffed array lengths to discover a no-op it could not explain.
    expect(outcome).toEqual({ kind: "not-quarantined", elsewhere: [onOther] });
    expect(updates).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("no live row: says so instead of nothing", async () => {
    storedState = undefined;

    const outcome = await releaseProvider({
      modelKey: "ghost",
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "cli" },
    });

    expect(outcome).toEqual({ kind: "no-live-row" });
    expect(updates).toHaveLength(0);
  });
});

describe("the pure derivations the HTTP layer will ship", () => {
  test("activeQuarantines excludes expired entries", () => {
    const state = fakeState({
      quarantinedProviders: [
        activeEntry("alpha"),
        { ...activeEntry("beta"), releaseAt: "2026-08-01T00:00:00.000Z" },
      ],
    });

    expect(activeQuarantines(state, NOW).map((e) => e.provider)).toEqual([
      "alpha",
    ]);
  });

  test("effectivePoolFor narrows `only` and always carries quarantines in `ignore`", () => {
    const state = fakeState({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      quarantinedProviders: [activeEntry("alpha")],
    });

    expect(effectivePoolFor(state, "gateway", NOW)).toEqual({
      only: ["beta"],
      ignore: ["alpha"],
    });
  });

  test("a widened pool drops `only` but still ignores the bad host", () => {
    // This is the distinction `list` prints as "open": no `only` on the wire,
    // so routing is open MINUS the quarantines — never back onto them.
    const state = fakeState({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      quarantinedProviders: [activeEntry("alpha")],
      poolWidened: true,
    });

    expect(effectivePoolFor(state, "gateway", NOW)).toEqual({
      ignore: ["alpha"],
    });
  });
});
