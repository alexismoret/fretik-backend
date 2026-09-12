import { AA_INDEX } from "@fretik/shared/model-registry/eligibility";
import type {
  DynamicProfile,
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { synthesizeProfileFromLive } from "../../src/lib/model-registry/effective";
import type { ModelProfile } from "../../src/lib/model-registry/types";
import { setLiveStateDouble } from "./live-state-double";

/**
 * A synthetic fleet, for tests that used to read the curated registry.
 *
 * Those tests iterated `MODEL_PROFILES` and asserted invariants over it — that
 * every profile's native-input policy stays inside its catalogue facts, that a
 * reasoning ladder never offers a rung the model rejects, and so on. The
 * registry is derived now, so asserting over a hand-written list would only
 * check that someone typed a list correctly. The same invariants are asserted
 * here over the DERIVATION: give the synthesiser a row, and the profile it
 * produces has to hold.
 *
 * That is a stronger test than the one it replaces. The old version could only
 * fail when a person edited a file; this one fails when the RULE is wrong, for
 * every model the sync will ever discover.
 */

export const dynamic = (
  over: Partial<DynamicProfile> = {},
): DynamicProfile => ({
  displayName: "Frontier 9",
  family: "acme",
  contextLength: 262_144,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools", "max_tokens"],
  supportsReasoning: false,
  supportsTools: true,
  derivedFrom: { source: "gateway+openrouter", at: "2026-08-30T03:00:00.000Z" },
  ...over,
});

export const endpoint = (over: Partial<EndpointStat> = {}): EndpointStat => ({
  provider: "acme-cloud",
  displayName: "Acme Cloud",
  wireNames: {},
  contextLength: 262_144,
  pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  supportedParameters: ["tools", "max_tokens", "reasoning"],
  ...over,
});

export const row = (over: Partial<LiveModelState> = {}): LiveModelState => ({
  profileKey: "acme-frontier-9",
  status: "published",
  transport: "openrouter",
  enabled: true,
  disabledReason: null,
  modelIds: { openrouter: "acme/frontier-9", gateway: "acme/frontier9" },
  providerPool: {},
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 260_096,
  effectiveMaxOutput: 32_768,
  pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  creditMultiplier: 0.7,
  health: "healthy",
  healthScore: 90,
  policyReport: null,
  endpointStats: [],
  aaMetrics: null,
  releasedAt: null,
  aaSlug: null,
  dynamicProfile: dynamic(),
  boundRoles: [],
  source: "sync",
  syncedAt: null,
  maxInputPricePerMTok: null,
  maxOutputPricePerMTok: null,
  minMaxOutput: null,
  minContextLength: null,
  requireCache: null,
  ...over,
});

/** The profile a row synthesises into. Throws rather than returning undefined. */
export const profileOf = (over: Partial<LiveModelState> = {}): ModelProfile => {
  const profile = synthesizeProfileFromLive(row(over));
  if (profile === undefined)
    throw new Error("row did not synthesise — it carries no dynamicProfile");
  return profile;
};

/**
 * Rows for the models `ROLE_BINDINGS` actually names, close enough to the real
 * ones that role resolution can be asserted end to end.
 *
 * The ids and pools below are what the sync has measured and written (checked
 * against the dev database on 2026-08-30). They are FIXTURE data, not
 * configuration: production reads its own rows, and the point of these is that
 * a test can pin what reaches the wire without a database.
 */
const DEEPSEEK_POOL = ["baseten", "fireworks", "venice", "deepinfra"];

/**
 * The measured half of a bound row — price, grade and per-endpoint speed.
 *
 * It used to be absent, and every bound row carried the generic $0.40/$1.60
 * placeholder with no grade and no throughput at all. That was invisible until
 * the eligibility floors started reading price and speed: the invariant test
 * that exists to prove "no function refuses its own default" was passing on a
 * fleet whose prices were made up, so it could not have caught a ceiling set
 * below the models it was written around.
 *
 * Prices are chosen to REPRODUCE the blended figure the sync measured on
 * 2026-08-30 (`blendedPricePerMTok` weights input 0.97 and reads 75 % of it
 * from cache), not copied off a rate card. Intelligence is the Artificial
 * Analysis v4.3 grade — a different scale from the v4.1 one these models were
 * first calibrated on, which is the whole reason the floors moved.
 */
interface Measured {
  /** AA Intelligence Index v4.3. */
  intelligence: number;
  /** Pool-median decode, tok/s. */
  tps: number;
  /** Pool-median time to first token, ms. */
  ttftMs: number;
  pricing: { inputPerMTok: number; outputPerMTok: number; cacheRead: number };
}

const MEASURED: Record<string, Measured> = {
  // blended $0.062, 50 tok/s, 678 ms. Serves chat, workflow, pre-extract,
  // transform, compaction and three of the four memory writers — so it is the
  // row that every conversational and memory floor is calibrated against.
  "deepseek-v4-flash": {
    intelligence: 35,
    tps: 50,
    ttftMs: 678,
    pricing: { inputPerMTok: 0.17, outputPerMTok: 0.34, cacheRead: 0.017 },
  },
  // blended $0.099, 121 tok/s, 380 ms. The recall judge and the consolidator.
  "gpt-oss-120b": {
    intelligence: 12,
    tps: 121,
    ttftMs: 380,
    pricing: { inputPerMTok: 0.28, outputPerMTok: 0.42, cacheRead: 0.028 },
  },
  // blended $0.038, 67 tok/s, 408 ms. Titles and nothing else — too slow for
  // the quick-tasks speed rung and cheap enough that it does not matter.
  "gpt-oss-20b": {
    intelligence: 6,
    tps: 67,
    ttftMs: 408,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.2, cacheRead: 0.01 },
  },
  // blended $0.349, 81 tok/s, 2218 ms. The page builder.
  "gemini-3.7-flash": {
    intelligence: 40,
    tps: 81,
    ttftMs: 2218,
    pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75, cacheRead: 0.075 },
  },
  // blended $0.187, 9 tok/s, 1092 ms. Reads scanned pages, and nobody watches
  // it stream — which is why `vision` carries no speed floor.
  "gemini-3.5-flash-lite": {
    intelligence: 27,
    tps: 9,
    ttftMs: 1092,
    pricing: { inputPerMTok: 0.42, outputPerMTok: 1.68, cacheRead: 0.042 },
  },
  "gemini-3.1-flash-lite": {
    intelligence: 18,
    tps: 120,
    ttftMs: 700,
    pricing: { inputPerMTok: 0.075, outputPerMTok: 0.3, cacheRead: 0.019 },
  },
  "zai-glm-5-3-flash": {
    intelligence: 42,
    tps: 71,
    ttftMs: 1180,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.5, cacheRead: 0.03 },
  },
  "glm-5.2": {
    intelligence: 39,
    tps: 55,
    ttftMs: 1400,
    pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6, cacheRead: 0.11 },
  },
  // `deepseek-v4-pro` is DELIBERATELY ABSENT: the fixture needs one row nobody
  // has graded, because "absent evidence never refuses" is the rule the whole
  // engine turns on and a fully-measured fleet cannot exercise it. It is also
  // the one row here bound to no role, so leaving it ungraded costs no
  // invariant.
  "gpt-5.6-luna": {
    intelligence: 34,
    tps: 95,
    ttftMs: 900,
    pricing: { inputPerMTok: 0.25, outputPerMTok: 2, cacheRead: 0.025 },
  },
  "minimax-m3": {
    intelligence: 29,
    tps: 62,
    ttftMs: 1500,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheRead: 0.03 },
  },
};

/** The row fields `MEASURED` fills, applied to a row and its endpoints. */
const withMeasurements = (state: LiveModelState): LiveModelState => {
  const measured = MEASURED[state.profileKey];
  if (measured === undefined) return state;
  const pricing = {
    inputPerMTok: measured.pricing.inputPerMTok,
    outputPerMTok: measured.pricing.outputPerMTok,
    cacheReadPerMTok: measured.pricing.cacheRead,
  };
  return {
    ...state,
    pricing,
    aaMetrics: {
      fetchedAt: "2026-09-07T03:00:00.000Z",
      indexVersion: AA_INDEX.version,
      intelligenceIndex: measured.intelligence,
    },
    // Every endpoint carries the same figures, so the pool MEDIAN the signals
    // are built from is the number named above rather than an artefact of how
    // many hosts a fixture happens to list.
    endpointStats: state.endpointStats.map((stat) => ({
      ...stat,
      pricing,
      throughputP50: measured.tps,
      latencyP50Ms: measured.ttftMs,
    })),
  };
};

const BOUND_ROWS_RAW: readonly LiveModelState[] = [
  row({
    profileKey: "deepseek-v4-flash",
    modelIds: {
      openrouter: "deepseek/deepseek-v4-flash-0731",
      gateway: "deepseek/deepseek-v4-flash-0731",
    },
    providerPool: {
      openrouter: { only: DEEPSEEK_POOL, sort: "throughput" },
    },
    // No host reports bf16/fp16 — matching production, and the reason the
    // quantization floor is NOT sent for this model: filtering would keep only
    // the hosts that declare nothing and drop the two whose precision is known.
    endpointStats: [
      endpoint({ provider: "deepinfra", hasZdr: true, quantization: "fp8" }),
      endpoint({ provider: "baseten", hasZdr: true, quantization: "fp8" }),
      endpoint({ provider: "venice", hasZdr: true, quantization: "unknown" }),
    ],
    dynamicProfile: dynamic({
      family: "deepseek",
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["low", "high", "max"],
      },
    }),
  }),
  row({
    profileKey: "minimax-m3",
    modelIds: { openrouter: "minimax/minimax-m3" },
    providerPool: {
      openrouter: { only: ["Novita", "DeepInfra"], sort: "throughput" },
    },
    endpointStats: [endpoint({ provider: "novita", hasZdr: true })],
    // No published ladder — the level→budget table steers it.
    dynamicProfile: dynamic({
      family: "minimax",
      supportsReasoning: true,
      reasoning: { mandatory: false },
    }),
  }),
  row({
    profileKey: "gpt-oss-120b",
    modelIds: { openrouter: "openai/gpt-oss-120b" },
    providerPool: {
      openrouter: {
        only: ["cerebras", "groq", "deepinfra"],
        ignore: ["fireworks"],
        sort: "throughput",
      },
    },
    // Cerebras REPORTS fp16, which is what anchors the quantization floor: it
    // survives the filter on a stated precision rather than on silence, so the
    // fp4 host can be dropped without leaving only unmeasured ones.
    endpointStats: [
      endpoint({ provider: "cerebras", hasZdr: true, quantization: "fp16" }),
      endpoint({ provider: "groq", hasZdr: true, quantization: "unknown" }),
      endpoint({ provider: "coreweave", hasZdr: true, quantization: "fp4" }),
    ],
    dynamicProfile: dynamic({
      family: "openai",
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["low", "medium", "high"],
      },
    }),
  }),
  row({
    profileKey: "gpt-oss-20b",
    modelIds: { openrouter: "openai/gpt-oss-20b" },
    providerPool: {
      openrouter: {
        only: ["groq", "deepinfra"],
        ignore: ["fireworks"],
        sort: "throughput",
      },
    },
    // Cerebras REPORTS fp16, which is what anchors the quantization floor: it
    // survives the filter on a stated precision rather than on silence, so the
    // fp4 host can be dropped without leaving only unmeasured ones.
    endpointStats: [
      endpoint({ provider: "cerebras", hasZdr: true, quantization: "fp16" }),
      endpoint({ provider: "groq", hasZdr: true, quantization: "unknown" }),
      endpoint({ provider: "coreweave", hasZdr: true, quantization: "fp4" }),
    ],
    dynamicProfile: dynamic({
      family: "openai",
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["low", "medium", "high"],
      },
    }),
  }),
  ...(
    [
      ["gemini-3.5-flash-lite", "google/gemini-3.5-flash-lite"],
      ["gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite"],
      ["gemini-3.7-flash", "google/gemini-3.7-flash"],
    ] as const
  ).map(([profileKey, id]) =>
    row({
      profileKey,
      modelIds: { openrouter: id },
      providerPool: { openrouter: { only: ["google-vertex"] } },
      endpointStats: [endpoint({ provider: "google-vertex", hasZdr: true })],
      dynamicProfile: dynamic({
        family: "google",
        inputModalities: ["text", "image", "file"],
        supportsReasoning: true,
        reasoning: {
          mandatory: true,
          supportedEfforts: ["low", "medium", "high"],
        },
      }),
    }),
  ),
  // The page BUILDER since 2026-09-04. Reasoning is MANDATORY on it, which is
  // the branch `settingsForRole`'s `page-build` case turns on, and the pool is
  // the wire one — the two hosts quarantined out of it (`sailresearch`, 2048
  // output cap; `wafer`, reasoning that never converged) are absent here for
  // the same reason production drops them.
  row({
    profileKey: "zai-glm-5-3-flash",
    modelIds: {
      openrouter: "z-ai/glm-5.3-flash",
      gateway: "zai/glm-5.3-flash",
    },
    providerPool: {
      openrouter: {
        only: ["together", "novita", "baseten", "modal"],
        sort: "throughput",
      },
    },
    endpointStats: [
      endpoint({ provider: "together", hasZdr: true }),
      endpoint({ provider: "novita", hasZdr: true, quantization: "fp8" }),
    ],
    dynamicProfile: dynamic({
      family: "zai",
      inputModalities: ["text", "image", "video"],
      supportsReasoning: true,
      reasoning: {
        mandatory: true,
        supportedEfforts: ["max", "high", "low"],
      },
    }),
  }),
  // Not bound to any role — models a TEAM can pick, which is what the
  // per-team flagship cases need. `glm-5.2` carries the smallest real ladder
  // there is (two rungs), so it exercises the stored-depth branches.
  row({
    profileKey: "glm-5.2",
    modelIds: { openrouter: "z-ai/glm-5.2", gateway: "zai/glm-5.2" },
    providerPool: { openrouter: { only: ["novita"], sort: "throughput" } },
    endpointStats: [endpoint({ provider: "novita", hasZdr: true })],
    dynamicProfile: dynamic({
      family: "z-ai",
      supportsReasoning: true,
      reasoning: { mandatory: false, supportedEfforts: ["high", "xhigh"] },
    }),
  }),
  row({
    profileKey: "deepseek-v4-pro",
    modelIds: { openrouter: "deepseek/deepseek-v4-pro-0813" },
    providerPool: { openrouter: { only: ["deepinfra"], sort: "throughput" } },
    endpointStats: [endpoint({ provider: "deepinfra", hasZdr: true })],
    dynamicProfile: dynamic({
      family: "deepseek",
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["low", "high", "max"],
      },
    }),
  }),
  row({
    profileKey: "gpt-5.6-luna",
    modelIds: { openrouter: "openai/gpt-5.6-luna" },
    providerPool: { openrouter: { only: ["azure"] } },
    endpointStats: [
      endpoint({
        provider: "azure",
        hasZdr: true,
        // Azure advertises `max_completion_tokens`, never `max_tokens` — which
        // is what `omitMaxTokens` is derived from.
        supportedParameters: ["tools", "reasoning"],
      }),
    ],
    dynamicProfile: dynamic({
      family: "openai",
      inputModalities: ["text", "image", "file"],
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    }),
  }),
];

export const BOUND_ROWS: readonly LiveModelState[] =
  BOUND_ROWS_RAW.map(withMeasurements);

/** Install the bound fleet as the live snapshot. */
export const installBoundFleet = (): void => setLiveStateDouble(BOUND_ROWS);

/**
 * The synthesised profile for a bound key, without needing a snapshot — for
 * tests that want a REALISTIC profile (a real pool, a real ladder) rather than
 * the generic `acme` one.
 */
export const boundProfile = (profileKey: string): ModelProfile => {
  const source = BOUND_ROWS.find((r) => r.profileKey === profileKey);
  if (source === undefined)
    throw new Error(`no bound fixture row for "${profileKey}"`);
  const profile = synthesizeProfileFromLive(source);
  if (profile === undefined)
    throw new Error(`fixture row "${profileKey}" did not synthesise`);
  return profile;
};

/**
 * A fleet spanning the shapes the derivation has to handle: a plain text model,
 * a multimodal one, a full effort ladder, a reasoning-free model, a
 * budget-steered one, a cache-discounting one and a mandatory reasoner.
 */
export const FLEET: readonly ModelProfile[] = [
  profileOf(),
  profileOf({
    profileKey: "acme-vision",
    dynamicProfile: dynamic({
      family: "acme",
      inputModalities: ["text", "image", "file"],
      supportsReasoning: true,
      reasoning: { mandatory: false, supportedEfforts: ["low", "high"] },
    }),
  }),
  profileOf({
    profileKey: "acme-ladder",
    dynamicProfile: dynamic({
      supportsReasoning: true,
      reasoning: {
        mandatory: false,
        supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    }),
  }),
  profileOf({
    profileKey: "acme-budget",
    // A contract with no ladder — the level→budget table steers it.
    dynamicProfile: dynamic({
      supportsReasoning: true,
      reasoning: { mandatory: false },
    }),
  }),
  profileOf({
    profileKey: "acme-mandatory",
    dynamicProfile: dynamic({
      supportsReasoning: true,
      reasoning: {
        mandatory: true,
        supportedEfforts: ["low", "medium", "high"],
      },
    }),
  }),
  profileOf({
    profileKey: "acme-cached",
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
  }),
  profileOf({
    profileKey: "acme-premium",
    pricing: { inputPerMTok: 15, outputPerMTok: 75 },
    enabled: false,
    disabledReason: "cost",
  }),
];
