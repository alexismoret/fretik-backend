import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { modelAlerts, modelLiveState } from "../../../src/db/schema";
import type {
  EndpointStat,
  LiveModelState,
  ModelWriteActor,
  QuarantineEntry,
} from "../../../src/model-registry/types";
import { mockModule } from "../../lib/mock-module";

/**
 * The escalation ladder, against the database it actually writes to.
 *
 * This ran as a unit test until 2026-09-02, and the fake it ran against could
 * not see the two things the module was written for. `update().set().where()`
 * DROPPED the where, so nothing ever proved a write lands on its own row; and
 * `readLiveStateRowForUpdate` was mocked, so the `SELECT … FOR UPDATE` — whose
 * comment says in as many words that without it "the loser's quarantine
 * vanishes with no error anywhere" — never ran once. A quarantine bug did ship
 * in this area (quarantines that could never be released, 2026-09-02), which
 * is the strongest available evidence that the fake was blind to what matters.
 *
 * `raiseModelAlert` is real here too: it writes `model_alerts`, and an alert
 * nobody can read is the same defect one rung down.
 *
 * `invalidateLiveRegistry` stays doubled — it publishes on Redis to tell other
 * replicas to reload, which has no observable trace in this process. Counting
 * the calls is the only way to state "the fleet was told", and that claim is
 * half of why the announce step sits OUTSIDE the transaction.
 *
 * The rung is chosen by two counts, so each row below is built to force one:
 *   vetted = members of `providerPool[transport].only` left once the target
 *            goes (undefined when the pool is widened or has no `only`)
 *   clean  = distinct providers in `endpointStats` left once the target goes
 */

const NOW = new Date("2026-08-31T12:00:00.000Z");
/** 7 days on from NOW — `QUARANTINE_DAYS`, restated so the test can assert it. */
const RELEASE_AT = "2026-09-07T12:00:00.000Z";

let invalidations = 0;

await mockModule("../../src/services/model-registry/live", {
  invalidateLiveRegistry: () => {
    invalidations += 1;
    return Promise.resolve();
  },
});

const { quarantineProvider, releaseProvider } =
  await import("../../../src/services/model-registry/breaker");
const { readLiveStateRow } =
  await import("../../../src/services/model-registry/live");

const endpoint = (provider: string): EndpointStat => ({
  provider,
  displayName: provider,
  wireNames: { gateway: provider },
  contextLength: 128_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
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

/** Profile keys this file created, dropped after every test. */
let created: string[] = [];

/**
 * One live-state row, with a key nothing else can collide with.
 *
 * `model_live_state` is a global table — no organization, no team — so two
 * suites sharing a database can only stay apart by never drawing the same key.
 */
const seedModel = async (
  overrides: Partial<LiveModelState> = {},
): Promise<string> => {
  const profileKey = `it-${randomUUID().slice(0, 8)}`;
  created.push(profileKey);
  await db.insert(modelLiveState).values({
    profileKey,
    status: "published",
    transport: "gateway",
    enabled: true,
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
    endpointStats: [endpoint("alpha"), endpoint("beta")],
    boundRoles: [],
    source: "sync",
    syncedAt: new Date("2026-08-01"),
    ...overrides,
  });
  return profileKey;
};

/** The row as it now stands, read back through the production reader. */
const reread = async (profileKey: string): Promise<LiveModelState> => {
  const row = await readLiveStateRow(profileKey);
  if (!row) throw new Error(`row ${profileKey} vanished`);
  return row;
};

const alertsFor = async (profileKey: string) =>
  db
    .select({
      kind: modelAlerts.kind,
      severity: modelAlerts.severity,
      message: modelAlerts.message,
    })
    .from(modelAlerts)
    .where(eq(modelAlerts.modelKey, profileKey))
    .orderBy(asc(modelAlerts.id));

const quarantine = (
  profileKey: string,
  actor: ModelWriteActor = { kind: "cli" },
  provider = "alpha",
) =>
  quarantineProvider({
    modelKey: profileKey,
    provider,
    transport: "gateway",
    kind: "upstream-cut",
    reason: "test",
    actor,
    now: NOW,
  });

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

beforeEach(() => {
  invalidations = 0;
  created = [];
});

afterEach(async () => {
  if (created.length === 0) return;
  await db.delete(modelAlerts).where(inArray(modelAlerts.modelKey, created));
  await db
    .delete(modelLiveState)
    .where(inArray(modelLiveState.profileKey, created));
});

describe("quarantineProvider — the ladder", () => {
  test("rung 1: vetted members left → plain quarantine", async () => {
    const key = await seedModel({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });

    const outcome = await quarantine(key);

    expect(outcome).toEqual({
      kind: "quarantined",
      entry: expectedEntry,
      remaining: 1,
      remainingSource: "vetted",
    });
    const row = await reread(key);
    expect(row.quarantinedProviders).toEqual([expectedEntry]);
    expect(row.source).toBe("admin");
    // Only the quarantine list moves: no widening, no transport change.
    expect(row.poolWidened).toBe(false);
    expect(row.transport).toBe("gateway");
    expect(row.lastResort).toBe(false);

    const alerts = await alertsFor(key);
    expect(alerts[0]).toMatchObject({
      kind: "quarantine",
      severity: "critical",
    });
    expect(alerts[0]?.message).toContain("1 upstream(s) left");
    expect(invalidations).toBe(1);
  });

  test("the write lands on its own row and no other", async () => {
    // `update().set().where()` in the old fake DROPPED the where clause, so
    // every write in this file was applied to nothing and asserted from a
    // captured object. A second, untouched row is the only way to say that the
    // WHERE is there at all.
    const key = await seedModel({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });
    const bystander = await seedModel({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });

    await quarantine(key);

    expect((await reread(key)).quarantinedProviders).toHaveLength(1);
    expect((await reread(bystander)).quarantinedProviders).toEqual([]);
  });

  test("rung 1 counts live endpoints when there is no vetted pool", async () => {
    // `vetted` is undefined here, so the ladder falls back to counting live
    // endpoints — two hosts on record, one left once alpha goes. The outcome
    // says WHICH count it used, so an operator reading "1 left" knows whether
    // that is one vetted host or one unmeasured one.
    const key = await seedModel();

    const outcome = await quarantine(key);

    expect(outcome).toMatchObject({
      kind: "quarantined",
      remaining: 1,
      remainingSource: "endpoints",
    });
    expect((await reread(key)).poolWidened).toBe(false);
  });

  test("rung 2: vetted pool exhausted but the transport has other hosts → widen", async () => {
    const key = await seedModel({
      providerPool: { gateway: { only: ["alpha"] } },
    });

    const outcome = await quarantine(key);

    expect(outcome).toEqual({
      kind: "pool-widened",
      entry: expectedEntry,
      remaining: 1,
    });
    expect((await reread(key)).poolWidened).toBe(true);
    const alerts = await alertsFor(key);
    expect(alerts[0]?.message).toContain("last VETTED upstream");
    // An unmeasured upstream is a risk; a measured-bad one is a certainty.
    expect(alerts[0]?.message).toContain("OPEN");
  });

  test("rung 3: nothing clean here, the model exists elsewhere → switch transport", async () => {
    const key = await seedModel({
      modelIds: { gateway: "acme/m1", openrouter: "acme/m-1" },
      providerPool: { gateway: { only: ["alpha"] } },
      endpointStats: [endpoint("alpha")],
    });

    const outcome = await quarantine(key);

    expect(outcome).toEqual({
      kind: "transport-switched",
      entry: expectedEntry,
      from: "gateway",
      to: "openrouter",
    });
    const row = await reread(key);
    expect(row.transport).toBe("openrouter");
    expect(row.poolWidened).toBe(false);
    expect((await alertsFor(key))[0]?.message).toContain(
      "SWITCHED to openrouter",
    );
  });

  test("rung 4: nothing anywhere → stays in service, marked last resort", async () => {
    const key = await seedModel({
      providerPool: { gateway: { only: ["alpha"] } },
      endpointStats: [endpoint("alpha")],
    });

    const outcome = await quarantine(key);

    // This rung WRITES and used to return `false`, i.e. "nothing changed" for
    // the single most serious branch. It is now its own outcome.
    expect(outcome).toEqual({ kind: "last-resort" });
    const row = await reread(key);
    expect(row.lastResort).toBe(true);
    expect(row.health).toBe("failing");
    expect(row.source).toBe("admin");
    // Note what is NOT written: the quarantine entry itself is discarded, so
    // the model keeps routing to its least-bad host rather than to nothing.
    expect(row.quarantinedProviders).toEqual([]);
    expect((await alertsFor(key))[0]).toMatchObject({
      kind: "quarantine-skipped",
      severity: "critical",
    });
    expect(invalidations).toBe(1);
  });

  test("providers quarantined concurrently ALL survive", async () => {
    // The lost update `readLiveStateRowForUpdate` exists to prevent, and the
    // one claim the old suite could not make at all: `quarantined_providers`
    // is a jsonb array rewritten wholesale, so writers that all read the old
    // array each write their own entry over the others' — and the losers'
    // quarantines disappear with no error anywhere.
    //
    // FOUR writers rather than two on purpose. With the lock the outcome is
    // deterministic whatever the count; without it, two racing writers happen
    // to serialise often enough to look fine, and a test that only sometimes
    // notices a missing lock is a test that will be believed on the run where
    // it passed.
    const hosts = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const key = await seedModel({
      providerPool: { gateway: { only: hosts } },
      endpointStats: hosts.map(endpoint),
    });

    await Promise.all(
      hosts
        .slice(0, 4)
        .map(async (host) => quarantine(key, { kind: "breaker" }, host)),
    );

    const providers = (await reread(key)).quarantinedProviders
      .map((e) => e.provider)
      .sort();
    expect(providers).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  test("the actor decides the provenance stamp", async () => {
    // The same function serves a runtime detector and a person, and it used to
    // record `admin` for both — a column that could not tell a machine from a
    // human, invisible until a screen puts a name beside the word.
    const byBreaker = await seedModel({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });
    await quarantine(byBreaker, { kind: "breaker" });
    expect((await reread(byBreaker)).source).toBe("breaker");

    // A person is a person whichever door they came through: WHO exactly
    // belongs in the action log, not in this column.
    const byOperator = await seedModel({
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });
    await quarantine(byOperator, { kind: "operator", userId: "user-1" });
    expect((await reread(byOperator)).source).toBe("admin");
  });
});

describe("quarantineProvider — the two exits that really are no-ops", () => {
  test("already quarantined: reports the standing entry, writes nothing", async () => {
    const standing = activeEntry("alpha");
    const key = await seedModel({ quarantinedProviders: [standing] });

    const outcome = await quarantine(key);

    // The ENTRY comes back, so the caller can say "until when" without
    // re-reading the row and guessing which quarantine is the right one.
    expect(outcome).toEqual({ kind: "already-quarantined", entry: standing });
    expect((await reread(key)).quarantinedProviders).toEqual([standing]);
    expect(await alertsFor(key)).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("an EXPIRED quarantine does not count as already quarantined", async () => {
    const key = await seedModel({
      quarantinedProviders: [
        { ...activeEntry("alpha"), releaseAt: "2026-08-01T00:00:00.000Z" },
      ],
    });

    const outcome = await quarantine(key);

    expect(outcome.kind).toBe("quarantined");
    // The expired row is dropped rather than kept: the column holds current
    // state, the incidents table is the history.
    expect((await reread(key)).quarantinedProviders).toEqual([expectedEntry]);
  });

  test("no live row: records the finding and stops", async () => {
    const ghost = `it-ghost-${randomUUID().slice(0, 8)}`;
    created.push(ghost);

    const outcome = await quarantineProvider({
      modelKey: ghost,
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
    expect(await readLiveStateRow(ghost)).toBeUndefined();
    expect((await alertsFor(ghost))[0]).toMatchObject({
      kind: "quarantine-skipped",
      severity: "warning",
    });
    expect(invalidations).toBe(0);
  });
});

describe("releaseProvider", () => {
  test("restores the host, re-narrows routing and lifts last resort", async () => {
    const standing = activeEntry("alpha");
    const key = await seedModel({
      quarantinedProviders: [standing],
      providerPool: { gateway: { only: ["alpha", "beta"] } },
      poolWidened: true,
      lastResort: true,
    });

    const outcome = await releaseProvider({
      modelKey: key,
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
    const row = await reread(key);
    expect(row.quarantinedProviders).toEqual([]);
    expect(row.poolWidened).toBe(false);
    expect(row.lastResort).toBe(false);
    // This write recorded no provenance at all until 2026-08-31, alone among
    // its siblings.
    expect(row.source).toBe("sync");
    expect((await alertsFor(key))[0]).toMatchObject({ kind: "release" });
    expect(invalidations).toBe(1);
  });

  test("releasing one provider leaves the others quarantined", async () => {
    const key = await seedModel({
      quarantinedProviders: [activeEntry("alpha"), activeEntry("beta")],
      providerPool: { gateway: { only: ["alpha", "beta"] } },
    });

    await releaseProvider({
      modelKey: key,
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "sync" },
    });

    expect(
      (await reread(key)).quarantinedProviders.map((e) => e.provider),
    ).toEqual(["beta"]);
  });

  test("a provider that was not quarantined names where it IS quarantined", async () => {
    const onOther: QuarantineEntry = {
      ...activeEntry("alpha"),
      transport: "openrouter",
    };
    const key = await seedModel({
      quarantinedProviders: [activeEntry("beta"), onOther],
    });

    const outcome = await releaseProvider({
      modelKey: key,
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "cli" },
    });

    // Quarantine is recorded PER TRANSPORT, and this function is the only
    // place that knows it. It used to return `void`, so the caller re-read the
    // row and diffed array lengths to discover a no-op it could not explain.
    expect(outcome).toEqual({ kind: "not-quarantined", elsewhere: [onOther] });
    expect((await reread(key)).quarantinedProviders).toHaveLength(2);
    expect(await alertsFor(key)).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("no live row: says so instead of nothing", async () => {
    const ghost = `it-ghost-${randomUUID().slice(0, 8)}`;
    created.push(ghost);

    const outcome = await releaseProvider({
      modelKey: ghost,
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "cli" },
    });

    expect(outcome).toEqual({ kind: "no-live-row" });
    expect(await readLiveStateRow(ghost)).toBeUndefined();
  });
});
