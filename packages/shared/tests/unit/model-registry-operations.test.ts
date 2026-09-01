import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveModelState } from "../../src/model-registry/types";
import { mockModule } from "./mock-module";

/**
 * The envelope around an operator write: consequences, and the action log.
 *
 * `operations.ts` decides nothing about whether a write is allowed — the
 * services do — so nothing here re-tests a guard. What it owns is the four
 * things a SURFACE needs and a service does not: the row before, the row
 * after, what the change means in codes a client can translate, and a line
 * naming who did it.
 *
 * The services are mocked, deliberately. Their behaviour is pinned in
 * `model-registry-admin.test.ts` and `model-registry-breaker.test.ts`; letting
 * them run here would make every assertion below depend on two files at once
 * and turn a consequence bug into a mystery.
 */

const fakeState = (
  overrides: Partial<LiveModelState> = {},
): LiveModelState => ({
  profileKey: "acme-m1",
  status: "candidate",
  transport: "gateway",
  enabled: false,
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

const NOW = new Date("2026-08-31T12:00:00.000Z");

let storedState: LiveModelState | undefined;
/** Rows that reached `model_admin_actions`. */
const actions: Record<string, unknown>[] = [];
/** Set to make the action-log insert fail. */
let failLog = false;

await mockModule("../../src/db", {
  default: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if (failLog) return Promise.reject(new Error("log insert failed"));
        actions.push(values);
        return Promise.resolve(undefined);
      },
    }),
  },
});

await mockModule("../../src/services/model-registry/live", {
  readLiveStateRow: () => Promise.resolve(storedState),
});

// --- The services, stubbed to a fixed verdict per test -----------------------

let promoteVerdict: unknown = { kind: "promoted" };
let retireVerdict: unknown = { kind: "retired", previousStatus: "published" };
let enabledVerdict: unknown = {
  kind: "updated",
  enabled: false,
  disabledReason: "unavailable",
  boundRoles: [],
};
let quarantineVerdict: unknown = { kind: "last-resort" };
let releaseVerdict: unknown = { kind: "no-live-row" };

/** Set to make one key of a batch come back as a `failed` entry. */
let failBatchKey: string | undefined;
let addVerdict: unknown = { kind: "not-a-language-model" };

await mockModule("../../src/services/model-registry/admin", {
  promoteCandidate: () => Promise.resolve(promoteVerdict),
  promoteCandidates: (keys: string[]) =>
    Promise.resolve(
      keys.map((profileKey) => ({
        profileKey,
        outcome:
          profileKey === failBatchKey
            ? { kind: "failed", message: "connection reset" }
            : promoteVerdict,
      })),
    ),
  retireModel: () => Promise.resolve(retireVerdict),
  setEnabled: () => Promise.resolve(enabledVerdict),
  setEnabledMany: (keys: string[]) =>
    Promise.resolve(
      keys.map((profileKey) => ({
        profileKey,
        outcome:
          profileKey === failBatchKey
            ? { kind: "failed", message: "connection reset" }
            : enabledVerdict,
      })),
    ),
  setTransport: () =>
    Promise.resolve({ kind: "switched", from: "gateway", to: "openrouter" }),
  acknowledgeAlert: () =>
    Promise.resolve({
      kind: "acknowledged",
      alertKind: "quarantine",
      modelKey: "acme-m1",
    }),
});

await mockModule("../../src/services/model-registry/add-from-catalogue", {
  addFromCatalogue: () => Promise.resolve(addVerdict),
});

await mockModule("../../src/services/model-registry/breaker", {
  quarantineProvider: () => Promise.resolve(quarantineVerdict),
  releaseProvider: () => Promise.resolve(releaseVerdict),
});

const {
  acknowledgeModelAlert,
  acknowledgeModelAlerts,
  addModelFromCatalogue,
  forecastEnablement,
  forecastPromotions,
  promoteModel,
  promoteModels,
  quarantineUpstream,
  releaseUpstream,
  retireModelOperation,
  setModelEnabled,
  setModelsEnabled,
  switchModelTransport,
} = await import("../../src/services/model-registry/operations");

const codes = (consequences: { code: string }[]) =>
  consequences.map((consequence) => consequence.code);

beforeEach(() => {
  actions.length = 0;
  failLog = false;
  storedState = fakeState();
  promoteVerdict = {
    kind: "promoted",
    enabled: true,
    disabledReason: null,
    pricing: { inputPerMTok: 1, outputPerMTok: 4 },
    catalogueDerivedOnly: false,
  };
  retireVerdict = { kind: "retired", previousStatus: "published" };
  enabledVerdict = {
    kind: "updated",
    enabled: false,
    disabledReason: "unavailable",
    boundRoles: [],
  };
  quarantineVerdict = { kind: "last-resort" };
  releaseVerdict = { kind: "no-live-row" };
  failBatchKey = undefined;
  addVerdict = { kind: "not-a-language-model" };
});

describe("consequences", () => {
  test("a promotion within budget has none", async () => {
    const result = await promoteModel({
      profileKey: "acme-m1",
      actor: { kind: "cli" },
      now: NOW,
    });

    // "candidate → published" is not a consequence, it is `after`. Attaching
    // an invariant to every response is how a list like this becomes noise.
    expect(result.consequences).toEqual([]);
    expect(result.before?.status).toBe("candidate");
  });

  test("a promotion over budget carries the figures AND the caps", async () => {
    promoteVerdict = {
      kind: "promoted",
      enabled: false,
      disabledReason: "cost",
      pricing: { inputPerMTok: 5, outputPerMTok: 20 },
      catalogueDerivedOnly: true,
    };

    const result = await promoteModel({
      profileKey: "acme-m1",
      actor: { kind: "cli" },
      now: NOW,
    });

    // The caps ride along because a client cannot derive them: they are a
    // backend policy constant, and a bare code would force the front to keep
    // its own copy of `PROMOTION_PRICE_CAPS`.
    expect(result.consequences).toEqual([
      {
        code: "published-disabled-on-cost",
        inputPerMTok: 5,
        outputPerMTok: 20,
        capInputPerMTok: 2,
        capOutputPerMTok: 8,
      },
      { code: "catalogue-derived-profile-only" },
    ]);
  });

  test("disabling a role-bound model names the roles it does NOT stop", async () => {
    enabledVerdict = {
      kind: "updated",
      enabled: false,
      disabledReason: "cost",
      boundRoles: ["chat", "documents-extract"],
    };

    const result = await setModelEnabled({
      profileKey: "acme-m1",
      enabled: false,
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(result.consequences).toEqual([
      { code: "roles-bypass-enabled", roles: ["chat", "documents-extract"] },
    ]);
  });

  test("enabling an unpublished model says teams still cannot pick it", async () => {
    storedState = fakeState({ status: "candidate", enabled: true });
    enabledVerdict = {
      kind: "updated",
      enabled: true,
      disabledReason: null,
      boundRoles: [],
    };

    const result = await setModelEnabled({
      profileKey: "acme-m1",
      enabled: true,
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(codes(result.consequences)).toEqual([
      "was-already-enabled",
      "still-unpublished",
    ]);
  });

  test("a transport switch reports the quarantines it KEPT", async () => {
    storedState = fakeState({
      quarantinedProviders: [
        {
          provider: "alpha",
          transport: "gateway",
          kind: "upstream-cut",
          quarantinedAt: "2026-08-30T12:00:00.000Z",
          releaseAt: "2026-09-06T12:00:00.000Z",
          incidentIds: [],
          reason: "test",
        },
      ],
    });

    const result = await switchModelTransport({
      profileKey: "acme-m1",
      transport: "openrouter",
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(result.consequences).toEqual([
      { code: "quarantines-kept-per-transport", kept: 1 },
    ]);
  });

  test("a widened pool carries the threshold the breaker would have needed", async () => {
    quarantineVerdict = {
      kind: "pool-widened",
      entry: { releaseAt: "2026-09-07T12:00:00.000Z" },
      remaining: 2,
    };

    const result = await quarantineUpstream({
      profileKey: "acme-m1",
      provider: "alpha",
      transport: "gateway",
      kind: "forbidden-codepoints",
      reason: "test",
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(result.consequences).toEqual([
      { code: "pool-widened", remaining: 2 },
      {
        code: "release-is-review-trigger",
        releaseAt: "2026-09-07T12:00:00.000Z",
      },
      // Another backend constant a client has no way to know.
      {
        code: "breaker-would-need",
        kind: "forbidden-codepoints",
        generations: 2,
        windowMinutes: 30,
      },
    ]);
  });

  test("the last-resort rung says the model stepped down, not the host", async () => {
    quarantineVerdict = { kind: "last-resort" };

    const result = await quarantineUpstream({
      profileKey: "acme-m1",
      provider: "alpha",
      transport: "gateway",
      kind: "upstream-cut",
      reason: "test",
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(codes(result.consequences)).toEqual(["now-last-resort"]);
  });

  test("a release reports only what it actually undid", async () => {
    releaseVerdict = {
      kind: "released",
      entry: { provider: "alpha" },
      poolRenarrowed: true,
      lastResortLifted: false,
    };

    const result = await releaseUpstream({
      profileKey: "acme-m1",
      provider: "alpha",
      transport: "gateway",
      reason: "test",
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(codes(result.consequences)).toEqual(["pool-renarrowed"]);
  });
});

describe("the action log", () => {
  test("records the operator's id, the outcome and both summaries", async () => {
    await promoteModel({
      profileKey: "acme-m1",
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      userId: "user-1",
      action: "promote",
      profileKey: "acme-m1",
      outcome: "promoted",
    });
    const payload = actions[0]?.payload;
    expect(payload).toHaveProperty("before");
    expect(payload).toHaveProperty("after");
  });

  test("a CLI write records no user, which is why the column is nullable", async () => {
    await promoteModel({
      profileKey: "acme-m1",
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(actions[0]?.userId).toBeNull();
  });

  test("REFUSALS are recorded too", async () => {
    retireVerdict = { kind: "refused-bound-roles", roles: ["chat"] };

    await retireModelOperation({
      profileKey: "acme-m1",
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    // "Someone tried to retire the chatbot's model and was stopped" is exactly
    // the line worth finding three weeks later, and a success-only log would
    // not have it.
    expect(actions[0]).toMatchObject({
      action: "retire",
      outcome: "refused-bound-roles",
    });
    // Nothing was written, so there is no `after` to record.
    expect(actions[0]?.payload).not.toHaveProperty("after");
  });

  test("an alert acknowledgement carries no model key", async () => {
    await acknowledgeModelAlert({
      alertId: "00000000-0000-0000-0000-000000000000",
      actor: { kind: "cli" },
      now: NOW,
    });

    // An alert can be raised about the sync itself, with no model at all.
    expect(actions[0]).toMatchObject({
      action: "ack-alert",
      profileKey: null,
      outcome: "acknowledged",
    });
  });

  test("a failing log does NOT fail the operation", async () => {
    failLog = true;

    const result = await promoteModel({
      profileKey: "acme-m1",
      actor: { kind: "cli" },
      now: NOW,
    });

    // The write already landed. Reporting an error for something that did in
    // fact happen is worse than an unlogged action.
    expect(result.outcome.kind).toBe("promoted");
    expect(actions).toHaveLength(0);
  });
});

describe("bulk promotion", () => {
  test("reports a verdict per key and logs one row each", async () => {
    const entries = await promoteModels({
      profileKeys: ["a", "b", "c"],
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    expect(entries.map((entry) => entry.profileKey)).toEqual(["a", "b", "c"]);
    expect(entries.every((entry) => entry.outcome.kind === "promoted")).toBe(
      true,
    );
    // Per-key, never an all-or-nothing envelope: one mistyped key must not
    // discard the decisions that did land.
    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.profileKey)).toEqual(["a", "b", "c"]);
  });

  test("a key that failed is logged as `failed`, not dropped", async () => {
    failBatchKey = "b";

    const entries = await promoteModels({
      profileKeys: ["a", "b", "c"],
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    expect(entries.map((entry) => entry.outcome.kind)).toEqual([
      "promoted",
      "failed",
      "promoted",
    ]);
    // A key that fell over is exactly the line worth finding later, so it goes
    // in the log beside the ones that landed rather than vanishing.
    expect(actions.map((action) => action.outcome)).toEqual([
      "promoted",
      "failed",
      "promoted",
    ]);
    expect(entries[1]?.consequences).toEqual([]);
  });
});

describe("bulk enable / disable", () => {
  test("names the roles that keep running when a model is disabled", async () => {
    enabledVerdict = {
      kind: "updated",
      enabled: false,
      disabledReason: "cost",
      boundRoles: ["chat", "vision"],
    };

    const entries = await setModelsEnabled({
      profileKeys: ["a", "b"],
      enabled: false,
      reason: "cost",
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    // The asymmetry that matters: `retire` REFUSES on a bound model, disable
    // does not — `enabled` gates team selection and a bound role resolves its
    // model directly, past the check. That sentence lived in a console.log.
    expect(codes(entries[0]?.consequences ?? [])).toEqual([
      "roles-bypass-enabled",
    ]);
    expect(actions.map((action) => action.action)).toEqual([
      "disable",
      "disable",
    ]);
  });

  test("ENABLING a bound model says nothing about roles", async () => {
    enabledVerdict = {
      kind: "updated",
      enabled: true,
      disabledReason: null,
      boundRoles: ["chat"],
    };

    const entries = await setModelsEnabled({
      profileKeys: ["a"],
      enabled: true,
      actor: { kind: "cli" },
      now: NOW,
    });

    // Enabling a model roles already bypass changes nothing for those roles.
    expect(entries[0]?.consequences).toEqual([]);
    expect(actions[0]?.action).toBe("enable");
  });

  test("a failed key is reported per key", async () => {
    failBatchKey = "b";

    const entries = await setModelsEnabled({
      profileKeys: ["a", "b"],
      enabled: true,
      actor: { kind: "cli" },
      now: NOW,
    });

    expect(entries.map((entry) => entry.outcome.kind)).toEqual([
      "updated",
      "failed",
    ]);
    expect(entries[1]?.consequences).toEqual([]);
  });
});

describe("acknowledging alerts in bulk", () => {
  test("reports each id and logs one row each", async () => {
    const entries = await acknowledgeModelAlerts({
      alertIds: ["id-1", "id-2"],
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    expect(entries.map((entry) => entry.alertId)).toEqual(["id-1", "id-2"]);
    expect(
      entries.every((entry) => entry.outcome.kind === "acknowledged"),
    ).toBe(true);
    // An alert can carry no model key at all, so these are not model actions.
    expect(actions.map((action) => action.profileKey)).toEqual([null, null]);
  });
});

describe("preflight", () => {
  test("promotion forecasts what the write will decide, without writing", async () => {
    storedState = fakeState({
      status: "candidate",
      pricing: { inputPerMTok: 400, outputPerMTok: 900 },
      dynamicProfile: null,
      boundRoles: ["chat"],
    });

    const [forecast] = await forecastPromotions(["acme-m1"]);

    // `promotionEnablement` is pure, so the confirmation screen can name the
    // models that will arrive DISABLED on cost before anyone commits — the
    // outcome that surprises people.
    expect(forecast?.willEnable).toBe(false);
    expect(forecast?.currentStatus).toBe("candidate");
    expect(forecast?.boundRoles).toEqual(["chat"]);
    expect(actions).toHaveLength(0);
  });

  test("an unknown key forecasts `unknown` rather than throwing", async () => {
    storedState = undefined;

    expect(await forecastPromotions(["ghost"])).toEqual([
      {
        profileKey: "ghost",
        currentStatus: "unknown",
        willEnable: false,
        catalogueDerivedOnly: false,
        boundRoles: [],
      },
    ]);
  });

  test("enablement forecasts a no-op as a no-op", async () => {
    storedState = fakeState({ enabled: true, boundRoles: ["chat"] });

    const [forecast] = await forecastEnablement(["acme-m1"], true);

    expect(forecast?.noOp).toBe(true);
    expect(forecast?.currentlyEnabled).toBe(true);
    expect(forecast?.boundRoles).toEqual(["chat"]);
    expect(actions).toHaveLength(0);
  });
});

describe("adding from the catalogue", () => {
  test("logs the add with the key it landed on", async () => {
    addVerdict = {
      kind: "added",
      profileKey: "acme-m2",
      state: fakeState({ profileKey: "acme-m2" }),
      endpoints: [],
      excluded: [],
    };

    const outcome = await addModelFromCatalogue({
      modelId: "acme/m2",
      actor: { kind: "operator", userId: "user-1" },
      now: NOW,
    });

    expect(outcome.kind).toBe("added");
    expect(actions[0]).toMatchObject({
      userId: "user-1",
      action: "add",
      profileKey: "acme-m2",
      outcome: "added",
    });
  });

  test("logs a REFUSAL too, with no key", async () => {
    addVerdict = { kind: "not-in-catalogue", catalogueSize: 362, near: [] };

    await addModelFromCatalogue({
      modelId: "acme/ghost",
      actor: { kind: "cli" },
      now: NOW,
    });

    // "Someone tried to add a model that does not exist" is the line a
    // success-only log would not have.
    expect(actions[0]).toMatchObject({
      userId: null,
      action: "add",
      profileKey: null,
      outcome: "not-in-catalogue",
    });
  });
});
