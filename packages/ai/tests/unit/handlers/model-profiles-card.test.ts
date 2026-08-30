import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { afterEach, describe, expect, test } from "bun:test";
import { buildCard } from "../../../src/handlers/model-profiles";
import { clearSynthesisedProfileCache } from "../../../src/lib/model-registry/effective";
import { MODEL_PROFILES } from "../../../src/lib/model-registry/profiles";
import { setLiveStateDouble } from "../../lib/live-state-double";

/**
 * What the hub is allowed to say about a model's SERVING.
 *
 * The engine routes one model across several companies and moves between them
 * on its own — quarantining a bad host, widening a pool, following throughput.
 * So naming the host a card was measured on is both a leak (a team learns who
 * we buy from) and a lie (by the time they read it, the traffic has moved).
 * Aggregates and counts are honest at any instant; names are not.
 *
 * That rule is easy to hold while writing `serving` and easy to break later,
 * because `endpointStats` carries the names two fields away from the numbers.
 * This test builds a card from a row whose every endpoint is loudly named and
 * asserts the serialised JSON contains none of them.
 */

const endpoint = (over: Partial<EndpointStat> = {}): EndpointStat => ({
  provider: "zenith",
  displayName: "Zenith Compute",
  wireNames: { openrouter: "zenith-ai" },
  contextLength: 262_144,
  pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  supportedParameters: ["tools"],
  uptime1d: 99.1,
  throughputP50: 80,
  ...over,
});

const row = (over: Partial<LiveModelState> = {}): LiveModelState => ({
  profileKey: "deepseek-v4-flash",
  status: "published",
  transport: "openrouter",
  enabled: true,
  disabledReason: null,
  modelIds: { openrouter: "deepseek/deepseek-v4-flash" },
  providerPool: { openrouter: { only: ["zenith-ai", "borealis-inference"] } },
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 260_096,
  effectiveMaxOutput: 32_768,
  pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  creditMultiplier: 0.7,
  health: "healthy",
  healthScore: 92,
  policyReport: null,
  endpointStats: [
    endpoint(),
    endpoint({
      provider: "borealis",
      displayName: "Borealis Inference",
      wireNames: { openrouter: "borealis-inference" },
      uptime1d: 97.4,
    }),
  ],
  aaMetrics: null,
  aaSlug: null,
  releasedAt: null,
  dynamicProfile: null,
  syncedAt: new Date("2026-08-30T03:00:00.000Z"),
  ...over,
});

const card = () =>
  buildCard(MODEL_PROFILES["deepseek-v4-flash"], {
    metrics: { metrics: {}, fetchedAt: "2026-08-30T03:00:00.000Z" },
    incidents: new Map([["deepseek-v4-flash", 3]]),
  });

afterEach(() => {
  setLiveStateDouble();
  clearSynthesisedProfileCache();
});

describe("buildCard serving", () => {
  test("names no upstream anywhere in the serialised card", () => {
    setLiveStateDouble([row()]);
    const json = JSON.stringify(card()).toLowerCase();
    for (const name of [
      "zenith",
      "borealis",
      "zenith compute",
      "borealis inference",
      "zenith-ai",
      "borealis-inference",
    ]) {
      expect(json).not.toContain(name.toLowerCase());
    }
  });

  test("reports the pool as a COUNT and uptime as its best route", () => {
    // The best rather than the mean: a team reads uptime as "can it serve me",
    // and it can, as long as one route is up — the engine picks that one.
    setLiveStateDouble([row()]);
    const serving = card().serving;
    expect(serving.poolSize).toBe(2);
    expect(serving.uptime1d).toBe(99.1);
    expect(serving.score).toBe(92);
    expect(serving.incidents7d).toBe(3);
    expect(serving.checkedAt).toBe("2026-08-30T03:00:00.000Z");
  });

  test("an unmeasured endpoint never counts as 0% uptime", () => {
    // `undefined` means the source said nothing. Folding it to zero would grade
    // a model as down on the strength of a missing field.
    setLiveStateDouble([
      row({ endpointStats: [endpoint({ uptime1d: undefined })] }),
    ]);
    expect(card().serving.uptime1d).toBeNull();
  });

  test("a cold snapshot reports nothing rather than zero", () => {
    // Before the first sync there is no measurement, and "0 incidents, 0
    // routes, 0% uptime" would read as a catastrophic model instead of an
    // unmeasured one.
    const serving = card().serving;
    expect(serving.score).toBeNull();
    expect(serving.uptime1d).toBeNull();
    expect(serving.poolSize).toBeNull();
    expect(serving.checkedAt).toBeNull();
  });

  test("carries no per-function verdict — those live on the menu", () => {
    // The regression this guards: putting `selectable` back on the card is the
    // natural-looking change that forces the response to repeat the whole fleet
    // once per function.
    setLiveStateDouble([row()]);
    const built = card();
    expect(built).not.toHaveProperty("selectable");
    expect(built).not.toHaveProperty("recommended");
  });
});
