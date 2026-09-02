import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { modelAlerts, modelLiveState } from "../../../src/db/schema";
import type {
  DynamicProfile,
  LiveModelState,
  PricingSnapshot,
} from "../../../src/model-registry/types";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * The operator writes on `model_live_state`, against the table itself.
 *
 * `services/model-registry/admin.ts` is the only module a person drives: every
 * function in it has exactly one caller, because the sync builds its own
 * update object and writes it directly. That is why the guards belong IN it
 * rather than in a caller — a guard living in one surface's presentation layer
 * protects only that surface.
 *
 * Three of these tests exist because that was not true until 2026-08-31.
 * `retireModel` retired a model internal roles run on, `setEnabled` wrote for
 * keys that do not exist, and `acknowledgeAlert` reported success on any id at
 * all; the refusals lived in the CLI, so the service could take the chatbot
 * down for anything else that called it.
 *
 * It ran against a faked `db` until 2026-09-02. That fake recorded `set()`
 * payloads and `onConflictDoNothing` targets, which is a record of what the
 * module INTENDED — the two questions worth asking are whether the UPDATE
 * matches its row and whether the conflict clause actually dedupes, and a fake
 * answers neither. `acknowledgeAlert` was the sharpest case: the fake told the
 * two tables apart by object identity, so "this write went to model_alerts and
 * not to the registry" was true of the double by construction.
 *
 * `invalidateLiveRegistry` stays doubled: it publishes on Redis so other
 * replicas reload, which leaves no trace in this process. Counting the calls
 * is the only way to state the invariant every batch here exists for — N
 * writes, ONE fleet-wide rebuild.
 */

let invalidations = 0;

await mockModule("../../src/services/model-registry/live", {
  invalidateLiveRegistry: () => {
    invalidations += 1;
    return Promise.resolve();
  },
});

const {
  acknowledgeAlert,
  addCatalogueModel,
  promoteCandidate,
  promoteCandidates,
  retireModel,
  setEnabled,
  setEnabledMany,
  setTransport,
} = await import("../../../src/services/model-registry/admin");
const { readLiveStateRow } =
  await import("../../../src/services/model-registry/live");

const pricing = (
  overrides: Partial<PricingSnapshot> = {},
): PricingSnapshot => ({
  inputPerMTok: 1,
  outputPerMTok: 4,
  ...overrides,
});

/** A catalogue-derived profile: the shape a row carries when nobody wrote one. */
const derivedProfile = (): DynamicProfile => ({
  displayName: "Acme M1",
  family: "acme",
  contextLength: 128_000,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools"],
  supportsReasoning: false,
  supportsTools: true,
  derivedFrom: { source: "gateway", at: "2026-08-01" },
});

/** Keys and alert ids this file created, dropped after every test. */
let createdKeys: string[] = [];
let createdAlerts: string[] = [];

/**
 * One candidate row, with a key nothing else can collide with.
 *
 * `model_live_state` is global — no organization, no team — so two suites
 * sharing a database stay apart only by never drawing the same key.
 */
const seedModel = async (
  overrides: Partial<LiveModelState> & { policyFailStreak?: number } = {},
): Promise<string> => {
  const profileKey = `it-${randomUUID().slice(0, 8)}`;
  createdKeys.push(profileKey);
  await db.insert(modelLiveState).values({
    profileKey,
    status: "candidate",
    transport: "gateway",
    enabled: false,
    modelIds: { gateway: "acme/m1", openrouter: "acme/m-1" },
    providerPool: {},
    quarantinedProviders: [],
    poolWidened: false,
    lastResort: false,
    effectiveContextLength: 128_000,
    effectiveMaxOutput: 8_192,
    pricing: pricing(),
    creditMultiplier: 1,
    health: "healthy",
    healthScore: 90,
    endpointStats: [],
    boundRoles: [],
    source: "sync",
    syncedAt: new Date("2026-08-01"),
    ...overrides,
  });
  return profileKey;
};

/** A key with no row behind it, still registered so cleanup is unconditional. */
const ghostKey = (): string => {
  const key = `it-ghost-${randomUUID().slice(0, 8)}`;
  createdKeys.push(key);
  return key;
};

const reread = async (profileKey: string): Promise<LiveModelState> => {
  const row = await readLiveStateRow(profileKey);
  if (!row) throw new Error(`row ${profileKey} vanished`);
  return row;
};

/** `policyFailStreak` is a column the live-state view does not carry. */
const failStreak = async (profileKey: string): Promise<number> => {
  const [row] = await db
    .select({ streak: modelLiveState.policyFailStreak })
    .from(modelLiveState)
    .where(eq(modelLiveState.profileKey, profileKey));
  if (!row) throw new Error(`row ${profileKey} vanished`);
  return row.streak;
};

const seedAlert = async (modelKey: string): Promise<string> => {
  const [row] = await db
    .insert(modelAlerts)
    .values({
      kind: "quarantine",
      severity: "critical",
      modelKey,
      message: "seeded by the integration suite",
    })
    .returning({ id: modelAlerts.id });
  if (!row) throw new Error("failed to insert alert");
  createdAlerts.push(row.id);
  return row.id;
};

const alertsFor = async (modelKey: string) =>
  db
    .select({ kind: modelAlerts.kind, message: modelAlerts.message })
    .from(modelAlerts)
    .where(eq(modelAlerts.modelKey, modelKey))
    .orderBy(asc(modelAlerts.id));

beforeEach(() => {
  invalidations = 0;
  createdKeys = [];
  createdAlerts = [];
});

afterEach(async () => {
  if (createdAlerts.length > 0) {
    await db.delete(modelAlerts).where(inArray(modelAlerts.id, createdAlerts));
  }
  if (createdKeys.length > 0) {
    await db
      .delete(modelAlerts)
      .where(inArray(modelAlerts.modelKey, createdKeys));
    await db
      .delete(modelLiveState)
      .where(inArray(modelLiveState.profileKey, createdKeys));
  }
});

describe("setTransport", () => {
  test("reports an unknown model instead of throwing prose", async () => {
    expect(await setTransport(ghostKey(), "openrouter")).toEqual({
      kind: "unknown-model",
    });
  });

  test("names the ids a row DOES have when the target is missing", async () => {
    const key = await seedModel({ modelIds: { gateway: "acme/m1" } });

    // Model ids differ between transports and nothing derives one from the
    // other, so "which ones exist" is the actionable half of the refusal.
    expect(await setTransport(key, "openrouter")).toEqual({
      kind: "no-model-id",
      transport: "openrouter",
      available: ["gateway"],
    });
    expect((await reread(key)).transport).toBe("gateway");
  });

  test("a model already on that transport is a no-op, not a write", async () => {
    // This check used to live in the CLI, so any other caller re-wrote the row
    // and dropped `poolWidened` for nothing.
    const key = await seedModel({ poolWidened: true });

    expect(await setTransport(key, "gateway")).toEqual({
      kind: "already-on-transport",
      transport: "gateway",
    });
    expect((await reread(key)).poolWidened).toBe(true);
    expect(invalidations).toBe(0);
  });

  test("clears the routing slate but never touches quarantines", async () => {
    const standing = {
      provider: "alpha",
      transport: "gateway" as const,
      kind: "upstream-cut" as const,
      quarantinedAt: "2026-08-30T12:00:00.000Z",
      releaseAt: "2036-09-06T12:00:00.000Z",
      incidentIds: [],
      reason: "prior",
    };
    const key = await seedModel({
      poolWidened: true,
      lastResort: true,
      quarantinedProviders: [standing],
    });

    expect(await setTransport(key, "openrouter")).toEqual({
      kind: "switched",
      from: "gateway",
      to: "openrouter",
    });

    const row = await reread(key);
    expect(row.transport).toBe("openrouter");
    expect(row.poolWidened).toBe(false);
    expect(row.lastResort).toBe(false);
    expect(row.source).toBe("admin");
    // Quarantines are recorded PER TRANSPORT, so a switch keeps them.
    expect(row.quarantinedProviders).toEqual([standing]);
    expect(invalidations).toBe(1);
  });

  test("the write lands on its own row and no other", async () => {
    // The old fake's `update().set().where()` discarded the where clause, so
    // no test in this file could tell a targeted UPDATE from a table-wide one.
    const key = await seedModel();
    const bystander = await seedModel();

    await setTransport(key, "openrouter");

    expect((await reread(key)).transport).toBe("openrouter");
    expect((await reread(bystander)).transport).toBe("gateway");
  });

  test("still THROWS on a transport with no adapter, before reading anything", async () => {
    // The one throw kept in this module. `custom` is a real `TransportId`
    // deliberately absent from IMPLEMENTED_TRANSPORTS, so reaching it means a
    // caller offered a transport the build cannot serve — a bug, not a state
    // the operator is in, and the only thing left worth an exception.
    const key = await seedModel();

    const err = await rejection(setTransport(key, "custom"));

    expect(err.message).toMatch(/has no adapter/);
    expect((await reread(key)).transport).toBe("gateway");
  });
});

describe("setEnabled", () => {
  test("enabling clears the reason AND the policy-fail streak", async () => {
    // The streak reset is load-bearing: without it, yesterday's consecutive
    // hard-policy failures disable the model again on the next sync even
    // though the operator fixed the underlying problem.
    const key = await seedModel({
      enabled: false,
      disabledReason: "cost",
      policyFailStreak: 3,
    });

    await setEnabled(key, true);

    const row = await reread(key);
    expect(row.enabled).toBe(true);
    expect(row.disabledReason).toBeNull();
    expect(await failStreak(key)).toBe(0);
    expect(invalidations).toBe(1);
  });

  test("disabling without a reason files it as unavailable", async () => {
    const key = await seedModel({ enabled: true });

    await setEnabled(key, false);

    const row = await reread(key);
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("unavailable");
  });

  test("disabling keeps an explicit reason and leaves the streak alone", async () => {
    const key = await seedModel({ enabled: true, policyFailStreak: 2 });

    const outcome = await setEnabled(key, false, "cost");

    expect(outcome).toEqual({
      kind: "updated",
      enabled: false,
      disabledReason: "cost",
      boundRoles: [],
    });
    expect((await reread(key)).disabledReason).toBe("cost");
    // `policyFailStreak: undefined` in the payload has to mean "do not write
    // this column". Against a fake that was a property of the recorded object;
    // here it is a number that either moved or did not.
    expect(await failStreak(key)).toBe(2);
  });

  test("carries the bound roles, because disabling does NOT stop them", async () => {
    const key = await seedModel({ boundRoles: ["chat", "documents-extract"] });

    const outcome = await setEnabled(key, false);

    // `enabled` gates TEAM SELECTION only: a bound role resolves its profile
    // directly and bypasses the check, so those roles keep running on this
    // model. The caller can only say that if the outcome carries the roles.
    expect(outcome).toMatchObject({
      boundRoles: ["chat", "documents-extract"],
    });
  });

  test("refuses a key that does not exist", async () => {
    const ghost = ghostKey();
    const bystander = await seedModel({ enabled: true });

    expect(await setEnabled(ghost, false)).toEqual({ kind: "unknown-model" });
    // The UPDATE used to run anyway, match no row, and report success — the
    // CLI's own read was the only thing turning that into a 404.
    expect((await reread(bystander)).enabled).toBe(true);
    expect(invalidations).toBe(0);
  });
});

describe("promoteCandidate", () => {
  test("publishes and enables a candidate within budget", async () => {
    const key = await seedModel();

    const outcome = await promoteCandidate(key);

    expect(outcome).toEqual({
      kind: "promoted",
      enabled: true,
      disabledReason: null,
      pricing: pricing(),
      catalogueDerivedOnly: false,
    });
    const row = await reread(key);
    expect(row.status).toBe("published");
    expect(row.enabled).toBe(true);
    expect(row.disabledReason).toBeNull();
    expect(row.source).toBe("admin");

    const alerts = await alertsFor(key);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("new-candidate");
    expect(invalidations).toBe(1);
  });

  test("publishes but leaves DISABLED when the pool price is over budget", async () => {
    // Caps are $2 in / $8 out per MTok. Publishing and PAYING are separate
    // decisions: the model becomes visible either way. The outcome carries the
    // pricing so a caller can name the figures against the cap without
    // shipping `PROMOTION_PRICE_CAPS` to the client and re-deriving the rule.
    const key = await seedModel({
      pricing: pricing({ inputPerMTok: 5, outputPerMTok: 20 }),
    });

    const outcome = await promoteCandidate(key);

    expect(outcome).toMatchObject({
      kind: "promoted",
      enabled: false,
      disabledReason: "cost",
      pricing: { inputPerMTok: 5, outputPerMTok: 20 },
    });
    const row = await reread(key);
    expect(row.status).toBe("published");
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("cost");
    expect((await alertsFor(key))[0]?.message).toContain("DISABLED on cost");
  });

  test("flags a model running on catalogue facts alone", async () => {
    const key = await seedModel({ dynamicProfile: derivedProfile() });

    const outcome = await promoteCandidate(key);

    // Supported, but it means nobody has recorded a reasoning envelope, a
    // cache strategy or a native-input policy for it.
    expect(outcome).toMatchObject({ catalogueDerivedOnly: true });
    expect((await alertsFor(key))[0]?.message).toContain(
      "catalogue-derived profile",
    );
  });

  test("an already published model reports the verdict without writing", async () => {
    const key = await seedModel({ status: "published", enabled: true });

    expect(await promoteCandidate(key)).toEqual({
      kind: "already-published",
      enabled: true,
      disabledReason: null,
    });
    expect(await alertsFor(key)).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("reports an unknown model", async () => {
    expect(await promoteCandidate(ghostKey())).toEqual({
      kind: "unknown-model",
    });
  });
});

describe("retireModel", () => {
  test("takes the model out of every picker", async () => {
    const key = await seedModel({ enabled: true });

    expect(await retireModel(key)).toEqual({
      kind: "retired",
      previousStatus: "candidate",
    });
    const row = await reread(key);
    expect(row.status).toBe("retired");
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("unavailable");
    expect(row.source).toBe("admin");
    expect(invalidations).toBe(1);
  });

  test("REFUSES a model bound to internal roles", async () => {
    // This guard lived only in the CLI while the service updated
    // unconditionally, so it protected one surface and nothing else — and
    // what it protects against is not a team losing a preference, it is the
    // chatbot losing its model.
    const key = await seedModel({
      status: "published",
      enabled: true,
      boundRoles: ["chatbot-flagship", "documents-extract"],
    });

    expect(await retireModel(key)).toEqual({
      kind: "refused-bound-roles",
      roles: ["chatbot-flagship", "documents-extract"],
    });
    const row = await reread(key);
    expect(row.status).toBe("published");
    expect(row.enabled).toBe(true);
    expect(invalidations).toBe(0);
  });

  test("refuses a key that does not exist", async () => {
    expect(await retireModel(ghostKey())).toEqual({ kind: "unknown-model" });
  });
});

describe("addCatalogueModel", () => {
  const candidate = (profileKey: string) => ({
    profileKey,
    transport: "gateway" as const,
    modelIds: { gateway: "acme/m2" },
    dynamicProfile: derivedProfile(),
    effectiveContextLength: 64_000,
    pricing: pricing(),
  });

  test("inserts an invisible candidate", async () => {
    const key = ghostKey();

    await addCatalogueModel(candidate(key));

    const row = await reread(key);
    // A candidate is invisible to teams: nothing routes to it and no picker
    // offers it until `promote` says so.
    expect(row.status).toBe("candidate");
    expect(row.enabled).toBe(false);
    expect(row.providerPool).toEqual({});
    expect(row.boundRoles).toEqual([]);
    expect(row.source).toBe("admin");
    expect(row.effectiveMaxOutput).toBeNull();
    expect(invalidations).toBe(1);
  });

  test("a duplicate key changes nothing at all", async () => {
    // Whether `onConflictDoNothing` really dedupes is precisely what a fake
    // that recorded its TARGET could not answer. The second call must neither
    // raise nor overwrite: the existing row is the one the sync has been
    // maintaining.
    const key = await seedModel({ status: "published", enabled: true });

    await addCatalogueModel(candidate(key));

    const row = await reread(key);
    expect(row.status).toBe("published");
    expect(row.enabled).toBe(true);
    expect(row.effectiveContextLength).toBe(128_000);
    // GAP, unchanged by this conversion: a collision is silently a no-op, and
    // only the CLI's read-back notices that the insert did not land.
    expect(invalidations).toBe(1);
  });
});

describe("acknowledgeAlert", () => {
  test("acknowledges a real alert and names what it was", async () => {
    const key = await seedModel();
    const id = await seedAlert(key);

    const outcome = await acknowledgeAlert(id);

    expect(outcome).toEqual({
      kind: "acknowledged",
      alertKind: "quarantine",
      modelKey: key,
    });
    const [row] = await db
      .select({ acknowledgedAt: modelAlerts.acknowledgedAt })
      .from(modelAlerts)
      .where(eq(modelAlerts.id, id));
    expect(row?.acknowledgedAt).toBeInstanceOf(Date);
    // Acknowledging changes nothing about the DECISION the alert reports — a
    // quarantine stays in force until its re-probe releases it — so no
    // registry invalidation here is correct.
    expect(invalidations).toBe(0);
  });

  test("acknowledging one alert leaves its neighbours open", async () => {
    const key = await seedModel();
    const first = await seedAlert(key);
    const second = await seedAlert(key);

    await acknowledgeAlert(first);

    const [row] = await db
      .select({ acknowledgedAt: modelAlerts.acknowledgedAt })
      .from(modelAlerts)
      .where(eq(modelAlerts.id, second));
    expect(row?.acknowledgedAt).toBeNull();
  });

  test("refuses an id no alert carries", async () => {
    const key = await seedModel();
    const untouched = await seedAlert(key);

    expect(await acknowledgeAlert(randomUUID())).toEqual({
      kind: "unknown-alert",
    });
    // The bare UPDATE it replaced matched no row and still reported success,
    // so a mistyped id was indistinguishable from a real acknowledgement.
    const [row] = await db
      .select({ acknowledgedAt: modelAlerts.acknowledgedAt })
      .from(modelAlerts)
      .where(eq(modelAlerts.id, untouched));
    expect(row?.acknowledgedAt).toBeNull();
  });
});

/**
 * The batch paths, and the two properties that justify their existence:
 * N writes drop the fleet's cache ONCE, and a key that blows up does not take
 * the rest of the batch with it.
 */
describe("batches", () => {
  const threeCandidates = async (): Promise<[string, string, string]> => [
    await seedModel(),
    await seedModel(),
    await seedModel(),
  ];

  test("promoteCandidates writes N rows and invalidates ONCE", async () => {
    const keys = await threeCandidates();

    const results = await promoteCandidates(keys);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "promoted",
      "promoted",
      "promoted",
    ]);
    for (const key of keys) {
      expect((await reread(key)).status).toBe("published");
    }
    // The invariant the whole batch exists for: an invalidation makes every
    // replica rebuild its memoised models, so three clicks must not be three
    // fleet-wide rebuilds during live traffic.
    expect(invalidations).toBe(1);
  });

  test("a key that THROWS becomes a `failed` entry, and the rest still land", async () => {
    const [first, , third] = await threeCandidates();
    // A NUL byte cannot travel in a Postgres text parameter, so this key makes
    // the READ fail at the driver — a real exception from a real connection,
    // where the old suite had a fake that rejected on request.
    const poison = `it-${String.fromCharCode(0)}-bad`;

    const results = await promoteCandidates([first, poison, third]);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "promoted",
      "failed",
      "promoted",
    ]);
    // Letting the exception out would abandon the first — already written,
    // with its alert raised — and skip the invalidation entirely, leaving the
    // operator unable to tell where the batch stopped.
    expect((await reread(first)).status).toBe("published");
    expect((await reread(third)).status).toBe("published");
    expect(invalidations).toBe(1);
  });

  test("a batch that writes NOTHING drops no cache", async () => {
    const keys = [
      await seedModel({ status: "published", enabled: true }),
      await seedModel({ status: "published", enabled: true }),
    ];

    const results = await promoteCandidates(keys);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "already-published",
      "already-published",
    ]);
    expect(invalidations).toBe(0);
  });

  test("setEnabledMany writes N rows and invalidates ONCE", async () => {
    const keys = await threeCandidates();

    const results = await setEnabledMany(keys, false, "cost");

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "updated",
      "updated",
      "updated",
    ]);
    for (const key of keys) {
      expect((await reread(key)).disabledReason).toBe("cost");
    }
    expect(invalidations).toBe(1);
  });

  test("setEnabledMany reports an unknown key without failing the batch", async () => {
    const [first, , third] = await threeCandidates();
    const ghost = ghostKey();

    const results = await setEnabledMany([first, ghost, third], true);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "updated",
      "unknown-model",
      "updated",
    ]);
    expect((await reread(first)).enabled).toBe(true);
    expect((await reread(third)).enabled).toBe(true);
    expect(invalidations).toBe(1);
  });
});
