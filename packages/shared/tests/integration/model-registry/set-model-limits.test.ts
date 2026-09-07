import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { modelAlerts, modelLiveState } from "../../../src/db/schema";
import type {
  EndpointStat,
  LiveModelState,
} from "../../../src/model-registry/types";
import { mockModule } from "../../lib/mock-module";

/**
 * Operator limits, against the table itself.
 *
 * What is worth proving here is not the filtering — `model-sync-compute` and
 * `model-sync-recompute` pin that with no database in sight — but the three
 * things only a real row can answer:
 *
 *  1. the recompute REACHES the columns routing reads (`provider_pool`,
 *     `pricing`, the effective context), rather than only the three settings;
 *  2. a cap that would leave nothing writes NOTHING, settings included;
 *  3. the settings survive, which is the whole reason they are columns — every
 *     jsonb column on this table except the pool and the quarantines is
 *     rewritten wholesale by the nightly pass.
 *
 * `invalidateLiveRegistry` stays doubled: it publishes on Redis so other
 * replicas reload, which leaves no trace in this process. Counting the calls is
 * the only way to state the invariant — one write, ONE fleet-wide rebuild.
 */

let invalidations = 0;

await mockModule("../../src/services/model-registry/live", {
  invalidateLiveRegistry: () => {
    invalidations += 1;
    return Promise.resolve();
  },
});

const { forecastModelLimits, setModelLimits } =
  await import("../../../src/services/model-registry/set-model-limits");
const { readLiveStateRow } =
  await import("../../../src/services/model-registry/live");

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  maxCompletionTokens: 32_768,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["max_tokens", "tools", "tool_choice"],
  hasZdr: true,
  ...over,
  wireNames: over.wireNames ?? { openrouter: over.provider },
});

/** Three hosts spanning a price range, so a cap has something to bite on. */
const THREE: EndpointStat[] = [
  endpoint({
    provider: "cheap",
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  }),
  endpoint({
    provider: "middling",
    pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
  }),
  endpoint({
    provider: "dear",
    pricing: { inputPerMTok: 9, outputPerMTok: 40 },
  }),
];

let createdKeys: string[] = [];

const seedModel = async (
  overrides: Partial<LiveModelState> = {},
): Promise<string> => {
  const profileKey = `it-${randomUUID().slice(0, 8)}`;
  createdKeys.push(profileKey);
  await db.insert(modelLiveState).values({
    profileKey,
    status: "published",
    transport: "openrouter",
    enabled: true,
    modelIds: { openrouter: "acme/m1" },
    providerPool: { openrouter: { only: THREE.map((e) => e.provider) } },
    quarantinedProviders: [],
    poolWidened: false,
    lastResort: false,
    effectiveContextLength: 129_024,
    effectiveMaxOutput: 32_768,
    // The median of the three above, which is what the sync would have written.
    pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
    creditMultiplier: 1,
    health: "healthy",
    healthScore: 90,
    endpointStats: THREE,
    boundRoles: [],
    source: "sync",
    syncedAt: new Date("2026-09-01"),
    ...overrides,
  });
  return profileKey;
};

const reread = async (profileKey: string): Promise<LiveModelState> => {
  const row = await readLiveStateRow(profileKey);
  if (!row) throw new Error(`row ${profileKey} vanished`);
  return row;
};

beforeEach(() => {
  invalidations = 0;
  createdKeys = [];
});

afterEach(async () => {
  if (createdKeys.length > 0) {
    await db
      .delete(modelAlerts)
      .where(inArray(modelAlerts.modelKey, createdKeys));
    await db
      .delete(modelLiveState)
      .where(inArray(modelLiveState.profileKey, createdKeys));
  }
});

describe("setModelLimits", () => {
  test("reports an unknown model instead of throwing prose", async () => {
    const { outcome } = await setModelLimits(`it-ghost-${randomUUID()}`, {
      maxInputPricePerMTok: 1,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome).toEqual({ kind: "unknown-model" });
    expect(invalidations).toBe(0);
  });

  test("an input cap drops the host AND re-derives everything routing reads", async () => {
    const key = await seedModel();
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: 1,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });

    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");
    expect(outcome.remaining).toBe(2);
    expect(outcome.dropped).toEqual([
      { provider: "dear", reason: "operator cap: input $9/MTok above $1" },
    ]);

    const row = await reread(key);
    // The settings landed…
    expect(row.maxInputPricePerMTok).toBe(1);
    expect(row.requireCache).toBe(false);
    // …and so did the pool the wire actually reads. This is the half a write
    // that only stored the three columns would have missed, leaving the model
    // routing to a host the operator had just priced out until 00:30.
    expect(row.providerPool.openrouter?.only).toEqual(["cheap", "middling"]);
    expect(row.providerPool.openrouter?.sort).toBe("throughput");
    // The MEASUREMENTS are untouched. They are the input to this recompute, so
    // narrowing them here would make raising the cap a no-op — the excluded
    // host would already be gone from the list the next recompute reads.
    expect(row.endpointStats.map((e) => e.provider)).toEqual([
      "cheap",
      "middling",
      "dear",
    ]);
    // The expensive host was dragging the median; that is the point of caps.
    expect(row.pricing.inputPerMTok).toBe(0.3);
    expect(row.source).toBe("admin");
    expect(invalidations).toBe(1);
  });

  test("a cap under every price writes NOTHING and names the cheapest", async () => {
    const key = await seedModel();
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: 0.01,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });

    expect(outcome.kind).toBe("cap-empties-pool");
    if (outcome.kind !== "cap-empties-pool") throw new Error("unreachable");
    // Unactionable without the number that WOULD work.
    expect(outcome.cheapestInputPerMTok).toBe(0.1);
    expect(outcome.wouldDrop).toHaveLength(3);

    const row = await reread(key);
    expect(row.maxInputPricePerMTok).toBeNull();
    expect(row.providerPool.openrouter?.only).toEqual([
      "cheap",
      "middling",
      "dear",
    ]);
    expect(invalidations).toBe(0);
  });

  test("clearing a cap restores the pool on the spot", async () => {
    const key = await seedModel();
    await setModelLimits(key, {
      maxInputPricePerMTok: 1,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });

    expect(outcome.kind).toBe("updated");
    const row = await reread(key);
    expect(row.maxInputPricePerMTok).toBeNull();
    // The host is back because the pool is RECOMPUTED, not patched: `only` is
    // never fed back into the filter that produces it.
    expect(row.providerPool.openrouter?.only).toEqual([
      "cheap",
      "middling",
      "dear",
    ]);
  });

  test("loosening after a sync has pruned the measurements says so", async () => {
    // The sync narrows `endpointStats` to the pool — it may, because it
    // re-fetches every endpoint first. So a cap set yesterday and cleared today
    // frees nobody NOW: the host is not in the stored measurements any more and
    // returns when the catalogue is next read. Saying "done" here would send
    // the operator looking for a fault that is not there.
    const key = await seedModel({
      maxInputPricePerMTok: 1,
      endpointStats: THREE.filter((e) => e.provider !== "dear"),
      providerPool: { openrouter: { only: ["cheap", "middling"] } },
    });
    const { outcome, awaitsSync } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome.kind).toBe("updated");
    expect(awaitsSync).toBe(true);
    expect((await reread(key)).providerPool.openrouter?.only).toEqual([
      "cheap",
      "middling",
    ]);
  });

  test("loosening that DOES free a host says nothing about waiting", async () => {
    const key = await seedModel({ maxInputPricePerMTok: 1 });
    const { outcome, awaitsSync } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome.kind).toBe("updated");
    expect(awaitsSync).toBe(false);
    expect((await reread(key)).providerPool.openrouter?.only).toContain("dear");
  });

  test("setting what already holds writes nothing and refuses nothing", async () => {
    const key = await seedModel();
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      // `null`, not `false`. A fresh row INHERITS its cache requirement, and
      // forcing the switch off is a different answer from not overriding it —
      // which is the whole reason the column holds three states.
      requireCache: null,
    });
    expect(outcome.kind).toBe("unchanged");
    expect(invalidations).toBe(0);
  });

  // The defect this whole mechanism was built for, end to end and on the real
  // numbers: on 2026-09-07 `deepseek-v4-flash` had sixteen in-pool hosts
  // advertising at least 384 000 output tokens and one advertising 32 768, and
  // reported itself capable of 32 768 — because `computeEffectiveContext` reads
  // the MINIMUM, which is the only honest reading while the weak host can still
  // serve a turn. Removing the host is what raises the number; nothing else
  // does, and nothing clamps a request against it at runtime.
  test("a capability floor lifts the model's declared output cap", async () => {
    const key = await seedModel({
      endpointStats: [
        endpoint({ provider: "venice", maxCompletionTokens: 32_768 }),
        endpoint({ provider: "fireworks", maxCompletionTokens: 943_718 }),
        endpoint({ provider: "parasail", maxCompletionTokens: 384_000 }),
      ],
      providerPool: {
        openrouter: { only: ["venice", "fireworks", "parasail"] },
      },
    });
    expect((await reread(key)).effectiveMaxOutput).toBe(32_768);

    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: 48_000,
      minContextLength: null,
      requireCache: null,
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");
    expect(outcome.dropped).toEqual([
      { provider: "venice", reason: "job floor: output cap 32768 below 48000" },
    ]);

    const row = await reread(key);
    expect(row.providerPool.openrouter?.only).not.toContain("venice");
    expect(row.effectiveMaxOutput).toBe(384_000);
  });

  test("forcing the switch OFF is a change, not a no-op", async () => {
    // The distinction the three-state column exists for. `false` says "do not
    // require a cache on this model even though a role bound to it does", and
    // a row that stored it as "same as unset" would silently discard the only
    // instruction an operator can give here.
    const key = await seedModel();
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome.kind).toBe("updated");
    expect((await reread(key)).requireCache).toBe(false);
  });

  test("`requireCache` keeps every host nothing has observed", async () => {
    // None of the three carries cache evidence — the switch is on and drops
    // nobody. That is the design, not a bug: an unobserved host has failed
    // nothing, and dropping it would be self-fulfilling.
    const key = await seedModel();
    const { outcome, unprovenCache } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: true,
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");
    expect(outcome.dropped).toEqual([]);
    expect(unprovenCache).toEqual(["cheap", "middling", "dear"]);
    expect((await reread(key)).requireCache).toBe(true);
  });

  test("`requireCache` drops a host our own traffic proved uncached", async () => {
    const key = await seedModel({
      endpointStats: [
        endpoint({
          provider: "cheap",
          pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
          measuredCacheReadRatio: 0.71,
          measuredCacheSamples: 400,
        }),
        endpoint({
          provider: "middling",
          pricing: { inputPerMTok: 0.5, outputPerMTok: 2 },
          measuredCacheReadRatio: 0.004,
          measuredCacheSamples: 900,
        }),
      ],
    });
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: null,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: true,
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");
    expect(outcome.dropped).toEqual([
      { provider: "middling", reason: "job floor: no cache (measured 0.00)" },
    ]);
    expect((await reread(key)).providerPool.openrouter?.only).toEqual([
      "cheap",
    ]);
  });

  test("a row with no endpoints yet accepts limits rather than refusing", async () => {
    // A model an operator configures BEFORE promoting has an empty pool
    // whatever the limits say. Refusing there would make the form unusable on
    // exactly the models it is most wanted on.
    const key = await seedModel({ endpointStats: [], providerPool: {} });
    const { outcome } = await setModelLimits(key, {
      maxInputPricePerMTok: 2,
      maxOutputPricePerMTok: 8,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome.kind).toBe("updated");
    const row = await reread(key);
    expect(row.maxInputPricePerMTok).toBe(2);
    // Nothing was recomputed over nothing: the stored context is untouched.
    expect(row.effectiveContextLength).toBe(129_024);
  });
});

describe("forecastModelLimits", () => {
  test("says what the write would do, and writes nothing", async () => {
    const key = await seedModel();
    const { outcome } = await forecastModelLimits(key, {
      maxInputPricePerMTok: 1,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });

    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");
    expect(outcome.dropped).toEqual([
      { provider: "dear", reason: "operator cap: input $9/MTok above $1" },
    ]);

    const row = await reread(key);
    expect(row.maxInputPricePerMTok).toBeNull();
    expect(row.providerPool.openrouter?.only).toEqual([
      "cheap",
      "middling",
      "dear",
    ]);
    expect(invalidations).toBe(0);
  });

  test("forecasts the refusal too, so the form can block before submitting", async () => {
    const key = await seedModel();
    const { outcome } = await forecastModelLimits(key, {
      maxInputPricePerMTok: 0.01,
      maxOutputPricePerMTok: null,
      minMaxOutput: null,
      minContextLength: null,
      requireCache: false,
    });
    expect(outcome.kind).toBe("cap-empties-pool");
  });
});
