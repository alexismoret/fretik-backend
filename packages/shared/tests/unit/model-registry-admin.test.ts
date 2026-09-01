import { beforeEach, describe, expect, test } from "bun:test";
import {
  modelAlerts,
  modelLiveState,
} from "../../src/db/schema/model-registry";
import type {
  DynamicProfile,
  LiveModelState,
  PricingSnapshot,
} from "../../src/model-registry/types";
import { mockModule } from "./mock-module";

/**
 * The operator writes on `model_live_state`.
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
 * down for anything else that called it. Each of those tests names what it is
 * protecting, so the next person to "simplify" a guard sees the cost first.
 *
 * `db`, `live` and `alerts` are mocked at module level so a write is readable:
 * `updates` holds every `set()` payload with the table it was aimed at, and
 * `invalidations` counts the Redis publishes — one per write is the invariant
 * the bulk paths will later have to keep.
 */

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

const fakeState = (
  overrides: Partial<LiveModelState> = {},
): LiveModelState => ({
  profileKey: "acme-m1",
  status: "candidate",
  transport: "gateway",
  enabled: false,
  disabledReason: null,
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

/** The single row the mocked registry holds; undefined means "no such model". */
let storedState: LiveModelState | undefined;
/** Extra rows, for the batch paths — most tests need exactly one. */
let extraStates: LiveModelState[] = [];
/** Make a read blow up for one key, so a batch's isolation is observable. */
let throwOnKey: string | undefined;
/** The single alert the mocked table holds; undefined means "no such alert". */
let storedAlert: { kind: string; modelKey: string | null } | undefined;
/** Every `set()` that reached an update builder, with its target table. */
const updates: { table: string; values: Record<string, unknown> }[] = [];
/** Every `values()` that reached an insert builder. */
const inserts: Record<string, unknown>[] = [];
/** `onConflictDoNothing` arguments, so the silent-duplicate path is visible. */
const conflicts: unknown[] = [];
/** Fleet-wide cache drops. Exactly one per write is the invariant. */
let invalidations = 0;
/** Alerts raised, so the promote message stays assertable. */
const alerts: { kind: string; message: string }[] = [];

/**
 * Which table a write hit, by IDENTITY rather than by reading Drizzle's
 * internal name symbol. `acknowledgeAlert` is the only function here that does
 * not touch `model_live_state`, and a mock that could not tell the two apart
 * would let that difference disappear silently.
 */
const tableName = (table: unknown): string =>
  table === modelLiveState
    ? "model_live_state"
    : table === modelAlerts
      ? "model_alerts"
      : "unknown";

await mockModule("../../src/db", {
  default: {
    // Only `acknowledgeAlert` reads through the builder; everything else in
    // this module reads via `readLiveStateRow`, which is mocked separately.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(storedAlert === undefined ? [] : [storedAlert]),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table: tableName(table), values });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return {
          onConflictDoNothing: (target: unknown) => {
            conflicts.push(target);
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  },
});

await mockModule("../../src/services/model-registry/live", {
  readLiveStateRow: (profileKey: string) => {
    if (profileKey === throwOnKey) {
      return Promise.reject(new Error("connection reset"));
    }
    if (storedState?.profileKey === profileKey) {
      return Promise.resolve(storedState);
    }
    return Promise.resolve(
      extraStates.find((state) => state.profileKey === profileKey),
    );
  },
  invalidateLiveRegistry: () => {
    invalidations += 1;
    return Promise.resolve();
  },
});

await mockModule("../../src/services/model-registry/alerts", {
  raiseModelAlert: (input: { kind: string; message: string }) => {
    alerts.push({ kind: input.kind, message: input.message });
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
} = await import("../../src/services/model-registry/admin");

const liveWrites = () =>
  updates.filter((entry) => entry.table === "model_live_state");

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  conflicts.length = 0;
  alerts.length = 0;
  invalidations = 0;
  storedState = fakeState();
  extraStates = [];
  throwOnKey = undefined;
  storedAlert = { kind: "quarantine", modelKey: "acme-m1" };
});

describe("setTransport", () => {
  test("reports an unknown model instead of throwing prose", async () => {
    storedState = undefined;

    expect(await setTransport("ghost", "openrouter")).toEqual({
      kind: "unknown-model",
    });
    expect(liveWrites()).toHaveLength(0);
  });

  test("names the ids a row DOES have when the target is missing", async () => {
    storedState = fakeState({ modelIds: { gateway: "acme/m1" } });

    // Model ids differ between transports and nothing derives one from the
    // other, so "which ones exist" is the actionable half of the refusal.
    expect(await setTransport("acme-m1", "openrouter")).toEqual({
      kind: "no-model-id",
      transport: "openrouter",
      available: ["gateway"],
    });
    expect(liveWrites()).toHaveLength(0);
  });

  test("a model already on that transport is a no-op, not a write", async () => {
    // This check used to live in the CLI, so any other caller re-wrote the row
    // and dropped `poolWidened` for nothing.
    expect(await setTransport("acme-m1", "gateway")).toEqual({
      kind: "already-on-transport",
      transport: "gateway",
    });
    expect(liveWrites()).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("clears the routing slate but never touches quarantines", async () => {
    expect(await setTransport("acme-m1", "openrouter")).toEqual({
      kind: "switched",
      from: "gateway",
      to: "openrouter",
    });

    const [write] = liveWrites();
    expect(write?.values).toEqual({
      transport: "openrouter",
      poolWidened: false,
      lastResort: false,
      source: "admin",
    });
    // Quarantines are recorded PER TRANSPORT, so a switch keeps them: the
    // absence of the key here is the assertion.
    expect(write?.values).not.toHaveProperty("quarantinedProviders");
    expect(invalidations).toBe(1);
  });

  test("still THROWS on a transport with no adapter, before reading anything", async () => {
    // The one throw kept in this module. `custom` is a real `TransportId`
    // deliberately absent from IMPLEMENTED_TRANSPORTS, so reaching it means a
    // caller offered a transport the build cannot serve — a bug, not a state
    // the operator is in, and the only thing left worth an exception.
    //
    // Not awaited on purpose: Bun 1.4 registers the assertion and fails the
    // test both on a mismatched message AND on a promise that resolves instead
    // of rejecting — the second being what a guard that stopped guarding looks
    // like. Adding `await` only earns a TS 80007 hint.
    expect(setTransport("acme-m1", "custom")).rejects.toThrow(/has no adapter/);
    expect(liveWrites()).toHaveLength(0);
  });
});

describe("setEnabled", () => {
  test("enabling clears the reason AND the policy-fail streak", async () => {
    await setEnabled("acme-m1", true);

    // The streak reset is load-bearing: without it, yesterday's consecutive
    // hard-policy failures disable the model again on the next sync even
    // though the operator fixed the underlying problem.
    expect(liveWrites()[0]?.values).toEqual({
      enabled: true,
      disabledReason: null,
      policyFailStreak: 0,
      source: "admin",
    });
    expect(invalidations).toBe(1);
  });

  test("disabling without a reason files it as unavailable", async () => {
    await setEnabled("acme-m1", false);

    expect(liveWrites()[0]?.values).toMatchObject({
      enabled: false,
      disabledReason: "unavailable",
    });
  });

  test("disabling keeps an explicit reason and leaves the streak alone", async () => {
    const outcome = await setEnabled("acme-m1", false, "cost");

    expect(outcome).toEqual({
      kind: "updated",
      enabled: false,
      disabledReason: "cost",
      boundRoles: [],
    });
    expect(liveWrites()[0]?.values).toEqual({
      enabled: false,
      disabledReason: "cost",
      policyFailStreak: undefined,
      source: "admin",
    });
  });

  test("carries the bound roles, because disabling does NOT stop them", async () => {
    storedState = fakeState({ boundRoles: ["chat", "documents-extract"] });

    const outcome = await setEnabled("acme-m1", false);

    // `enabled` gates TEAM SELECTION only: a bound role resolves its profile
    // directly and bypasses the check, so those roles keep running on this
    // model. The caller can only say that if the outcome carries the roles.
    expect(outcome).toMatchObject({
      boundRoles: ["chat", "documents-extract"],
    });
  });

  test("refuses a key that does not exist", async () => {
    storedState = undefined;

    expect(await setEnabled("ghost", false)).toEqual({ kind: "unknown-model" });
    // The UPDATE used to run anyway, match no row, and report success — the
    // CLI's own read was the only thing turning that into a 404.
    expect(liveWrites()).toHaveLength(0);
    expect(invalidations).toBe(0);
  });
});

describe("promoteCandidate", () => {
  test("publishes and enables a candidate within budget", async () => {
    const outcome = await promoteCandidate("acme-m1");

    expect(outcome).toEqual({
      kind: "promoted",
      enabled: true,
      disabledReason: null,
      pricing: pricing(),
      catalogueDerivedOnly: false,
    });
    expect(liveWrites()[0]?.values).toEqual({
      status: "published",
      enabled: true,
      disabledReason: null,
      source: "admin",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("new-candidate");
    expect(invalidations).toBe(1);
  });

  test("publishes but leaves DISABLED when the pool price is over budget", async () => {
    // Caps are $2 in / $8 out per MTok. Publishing and PAYING are separate
    // decisions: the model becomes visible either way. The outcome carries the
    // pricing so a caller can name the figures against the cap without
    // shipping `PROMOTION_PRICE_CAPS` to the client and re-deriving the rule.
    storedState = fakeState({
      pricing: pricing({ inputPerMTok: 5, outputPerMTok: 20 }),
    });

    const outcome = await promoteCandidate("acme-m1");

    expect(outcome).toMatchObject({
      kind: "promoted",
      enabled: false,
      disabledReason: "cost",
      pricing: { inputPerMTok: 5, outputPerMTok: 20 },
    });
    expect(liveWrites()[0]?.values).toMatchObject({
      status: "published",
      enabled: false,
      disabledReason: "cost",
    });
    expect(alerts[0]?.message).toContain("DISABLED on cost");
  });

  test("flags a model running on catalogue facts alone", async () => {
    storedState = fakeState({ dynamicProfile: derivedProfile() });

    const outcome = await promoteCandidate("acme-m1");

    // Supported, but it means nobody has recorded a reasoning envelope, a
    // cache strategy or a native-input policy for it.
    expect(outcome).toMatchObject({ catalogueDerivedOnly: true });
    expect(alerts[0]?.message).toContain("catalogue-derived profile");
  });

  test("an already published model reports the verdict without writing", async () => {
    storedState = fakeState({ status: "published" });

    expect(await promoteCandidate("acme-m1")).toEqual({
      kind: "already-published",
      enabled: true,
      disabledReason: null,
    });
    expect(liveWrites()).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("reports an unknown model", async () => {
    storedState = undefined;

    expect(await promoteCandidate("ghost")).toEqual({ kind: "unknown-model" });
  });
});

describe("retireModel", () => {
  test("takes the model out of every picker", async () => {
    expect(await retireModel("acme-m1")).toEqual({
      kind: "retired",
      previousStatus: "candidate",
    });
    expect(liveWrites()[0]?.values).toEqual({
      status: "retired",
      enabled: false,
      disabledReason: "unavailable",
      source: "admin",
    });
    expect(invalidations).toBe(1);
  });

  test("REFUSES a model bound to internal roles", async () => {
    storedState = fakeState({
      boundRoles: ["chatbot-flagship", "documents-extract"],
    });

    // This guard lived only in the CLI while the service updated
    // unconditionally, so it protected one surface and nothing else — and
    // what it protects against is not a team losing a preference, it is the
    // chatbot losing its model.
    expect(await retireModel("acme-m1")).toEqual({
      kind: "refused-bound-roles",
      roles: ["chatbot-flagship", "documents-extract"],
    });
    expect(liveWrites()).toHaveLength(0);
    expect(invalidations).toBe(0);
  });

  test("refuses a key that does not exist", async () => {
    storedState = undefined;

    expect(await retireModel("ghost")).toEqual({ kind: "unknown-model" });
    expect(liveWrites()).toHaveLength(0);
  });
});

describe("addCatalogueModel", () => {
  test("inserts an invisible candidate and swallows a duplicate", async () => {
    await addCatalogueModel({
      profileKey: "acme-m2",
      transport: "gateway",
      modelIds: { gateway: "acme/m2" },
      dynamicProfile: derivedProfile(),
      effectiveContextLength: 64_000,
      pricing: pricing(),
    });

    expect(inserts[0]).toMatchObject({
      profileKey: "acme-m2",
      status: "candidate",
      enabled: false,
      providerPool: {},
      boundRoles: [],
      source: "admin",
    });
    // A candidate is invisible to teams: nothing routes to it and no picker
    // offers it until `promote` says so.
    expect(inserts[0]?.effectiveMaxOutput).toBeNull();
    // GAP: a key collision is silently a no-op. Only the CLI's read-back
    // notices, which is how "the insert did not land" gets reported at all.
    expect(conflicts).toHaveLength(1);
    expect(invalidations).toBe(1);
  });
});

describe("acknowledgeAlert", () => {
  test("acknowledges a real alert and names what it was", async () => {
    const outcome = await acknowledgeAlert(
      "00000000-0000-0000-0000-000000000000",
    );

    expect(outcome).toEqual({
      kind: "acknowledged",
      alertKind: "quarantine",
      modelKey: "acme-m1",
    });
    const [write] = updates;
    expect(write?.table).toBe("model_alerts");
    expect(write?.values).toHaveProperty("acknowledgedAt");
    // Acknowledging changes nothing about the DECISION the alert reports — a
    // quarantine stays in force until its re-probe releases it — so no
    // registry invalidation here is correct.
    expect(invalidations).toBe(0);
  });

  test("refuses an id no alert carries", async () => {
    storedAlert = undefined;

    expect(
      await acknowledgeAlert("00000000-0000-0000-0000-000000000000"),
    ).toEqual({ kind: "unknown-alert" });
    // The bare UPDATE it replaced matched no row and still reported success,
    // so a mistyped id was indistinguishable from a real acknowledgement.
    expect(updates).toHaveLength(0);
  });
});

/**
 * The batch paths, and the two properties that justify their existence:
 * N writes drop the fleet's cache ONCE, and a key that blows up does not take
 * the rest of the batch with it.
 */
describe("batches", () => {
  const threeCandidates = (): void => {
    storedState = fakeState({ profileKey: "a" });
    extraStates = [
      fakeState({ profileKey: "b" }),
      fakeState({ profileKey: "c" }),
    ];
  };

  test("promoteCandidates writes N rows and invalidates ONCE", async () => {
    threeCandidates();

    const results = await promoteCandidates(["a", "b", "c"]);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "promoted",
      "promoted",
      "promoted",
    ]);
    expect(liveWrites()).toHaveLength(3);
    // The invariant the whole batch exists for: an invalidation makes every
    // replica rebuild its memoised models, so three clicks must not be three
    // fleet-wide rebuilds during live traffic.
    expect(invalidations).toBe(1);
  });

  test("a key that THROWS becomes a `failed` entry, and the rest still land", async () => {
    threeCandidates();
    throwOnKey = "b";

    const results = await promoteCandidates(["a", "b", "c"]);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "promoted",
      "failed",
      "promoted",
    ]);
    // Letting the exception out would abandon "a" — already written, with its
    // alert raised — and skip the invalidation entirely, leaving the operator
    // unable to tell where the batch stopped.
    expect(liveWrites()).toHaveLength(2);
    expect(invalidations).toBe(1);
  });

  test("a batch that writes NOTHING drops no cache", async () => {
    storedState = fakeState({ profileKey: "a", status: "published" });
    extraStates = [fakeState({ profileKey: "b", status: "published" })];

    const results = await promoteCandidates(["a", "b"]);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "already-published",
      "already-published",
    ]);
    expect(invalidations).toBe(0);
  });

  test("setEnabledMany writes N rows and invalidates ONCE", async () => {
    threeCandidates();

    const results = await setEnabledMany(["a", "b", "c"], false, "cost");

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "updated",
      "updated",
      "updated",
    ]);
    expect(liveWrites()).toHaveLength(3);
    expect(liveWrites().every((w) => w.values.disabledReason === "cost")).toBe(
      true,
    );
    expect(invalidations).toBe(1);
  });

  test("setEnabledMany reports an unknown key without failing the batch", async () => {
    threeCandidates();

    const results = await setEnabledMany(["a", "ghost", "c"], true);

    expect(results.map((r) => r.outcome.kind)).toEqual([
      "updated",
      "unknown-model",
      "updated",
    ]);
    expect(liveWrites()).toHaveLength(2);
    expect(invalidations).toBe(1);
  });
});
