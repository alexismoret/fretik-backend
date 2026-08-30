import type {
  DynamicProfile,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { afterEach, describe, expect, test } from "bun:test";
import {
  getEffectiveProfile,
  listEffectiveProfiles,
  synthesizeProfileFromLive,
} from "../../../src/lib/model-registry/effective";
import { MODEL_PROFILES } from "../../../src/lib/model-registry/profiles";
import { clearResolvedModelCache } from "../../../src/lib/model-registry/resolve";
import { setLiveStateDouble } from "../../lib/live-state-double";

/**
 * The half of the registry that needs no release.
 *
 * `promote` writes a row; until this layer existed nothing read it —
 * `getProfile` threw on any key outside `MODEL_PROFILES` and `dynamicProfile`
 * was written by the sync and consumed nowhere, so a promoted model was
 * invisible to every picker. What is asserted here is the synthesis itself,
 * because each of its defaults is a decision about a model NOBODY HAS LOOKED
 * AT, and the wrong default is silent every time.
 */

const dynamic = (over: Partial<DynamicProfile> = {}): DynamicProfile => ({
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

const row = (over: Partial<LiveModelState> = {}): LiveModelState => ({
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
  ...over,
});

afterEach(() => {
  setLiveStateDouble();
  clearResolvedModelCache();
});

describe("synthesis defaults", () => {
  test("the model id is the one for the transport the row ROUTES through", () => {
    // Never another transport's spelling of the same model: sending
    // `acme/frontier9` to OpenRouter is a 404, not a synonym.
    const profile = synthesizeProfileFromLive(row());
    expect(profile?.catalog.id).toBe("acme/frontier-9");
    expect(
      synthesizeProfileFromLive(row({ transport: "gateway" }))?.catalog.id,
    ).toBe("acme/frontier9");
  });

  test("context is the EFFECTIVE length, not the catalogue headline", () => {
    // The smallest any allowed endpoint offers, minus the safety margin.
    // Budgeting against the headline overflows the first turn that lands on
    // the smallest host.
    const profile = synthesizeProfileFromLive(row());
    expect(profile?.catalog.contextLength).toBe(260_096);
    expect(profile?.catalog.contextLength).not.toBe(262_144);
  });

  test("no reasoning contract is invented, even when the model advertises one", () => {
    // The catalogues publish the CAPABILITY without the ladder. An invented
    // ladder offers the picker rungs the upstream may reject, and
    // `require_parameters` turns a rejected rung into an empty pool rather
    // than a dropped field.
    const profile = synthesizeProfileFromLive(
      row({
        dynamicProfile: dynamic({
          supportsReasoning: true,
          supportedParameters: ["tools", "reasoning"],
        }),
      }),
    );
    expect(profile?.catalog.reasoning).toBeUndefined();
    expect(profile?.assessment.reasoning).toEqual({
      style: "none",
      defaultLevel: "none",
    });
  });

  test("images ride natively when published; file, video and audio do not", () => {
    const profile = synthesizeProfileFromLive(
      row({
        dynamicProfile: dynamic({
          inputModalities: ["text", "image", "file", "video", "audio"],
        }),
      }),
    );
    // `file` means PDF, and which dialect an upstream accepts is family
    // knowledge no catalogue publishes; video and audio have no call site
    // producing parts for them.
    expect(profile?.assessment.nativeInput).toEqual({
      image: true,
      video: false,
      fileMimeTypes: [],
      audio: false,
    });
  });

  test("a modality nothing models is dropped rather than carried through", () => {
    const profile = synthesizeProfileFromLive(
      row({
        dynamicProfile: dynamic({
          inputModalities: ["text", "image", "hologram"],
        }),
      }),
    );
    expect(profile?.catalog.inputModalities).toEqual(["text", "image"]);
  });

  test("no cache discount is claimed", () => {
    // `implicit` would tell the cost model to apply a discount nobody granted,
    // which under-reports what the model costs.
    expect(synthesizeProfileFromLive(row())?.assessment.cache).toEqual({
      strategy: "none",
    });
  });

  test("zero retention and require-parameters are both held", () => {
    expect(synthesizeProfileFromLive(row())?.assessment.provider).toEqual({
      requireParameters: true,
      zdr: true,
    });
  });

  test("the cost class comes from the blended pool price", () => {
    const budget = synthesizeProfileFromLive(
      row({ pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } }),
    );
    const premium = synthesizeProfileFromLive(
      row({ pricing: { inputPerMTok: 3, outputPerMTok: 12 } }),
    );
    expect(budget?.assessment.costClass).toBe("budget");
    expect(synthesizeProfileFromLive(row())?.assessment.costClass).toBe(
      "standard",
    );
    expect(premium?.assessment.costClass).toBe("premium");
  });

  test("a policy-disabled row gets a tooltip rather than none", () => {
    // `policy` has no counterpart in the profile vocabulary. Dropping it would
    // leave a disabled model with nothing to explain itself.
    const profile = synthesizeProfileFromLive(
      row({ enabled: false, disabledReason: "policy" }),
    );
    expect(profile?.assessment.enabled).toBe(false);
    expect(profile?.assessment.disabledReason).toBe("unavailable");
  });

  test("a row the sync never described yields no profile at all", () => {
    // A seeded curated row carries no `dynamicProfile`; its profile is the
    // TypeScript one, and synthesising a second would shadow it.
    expect(
      synthesizeProfileFromLive(row({ dynamicProfile: null })),
    ).toBeUndefined();
  });
});

describe("precedence and listing", () => {
  const curatedKey = Object.keys(MODEL_PROFILES)[0] ?? "";

  test("a curated profile wins EN BLOC over its live row", () => {
    // Not field by field: the hand-written half is a set of decisions that
    // hold together, and letting a nightly sync overwrite one leaves a profile
    // nobody designed.
    const curated = MODEL_PROFILES[curatedKey];
    setLiveStateDouble([
      row({
        profileKey: curatedKey,
        dynamicProfile: dynamic({ family: "impostor" }),
        pricing: { inputPerMTok: 999, outputPerMTok: 999 },
      }),
    ]);
    const effective = getEffectiveProfile(curatedKey);
    expect(effective).toBe(curated);
    expect(effective?.assessment.pricing.inputPerMTok).not.toBe(999);
  });

  test("a promoted model resolves from its row alone", () => {
    setLiveStateDouble([row()]);
    const profile = getEffectiveProfile("acme-frontier-9");
    expect(profile?.key).toBe("acme-frontier-9");
    expect(profile?.catalog.id).toBe("acme/frontier-9");
  });

  test("a cold snapshot serves the TypeScript registry and does not throw", () => {
    // What a replica that cannot reach the database should do.
    setLiveStateDouble();
    expect(getEffectiveProfile("acme-frontier-9")).toBeUndefined();
    expect(getEffectiveProfile(curatedKey)).toBeDefined();
    expect(listEffectiveProfiles()).toHaveLength(
      Object.keys(MODEL_PROFILES).length,
    );
  });

  test("the listing adds live models and never duplicates a curated one", () => {
    setLiveStateDouble([row(), row({ profileKey: curatedKey })]);
    const listed = listEffectiveProfiles();
    const keys = listed.map((profile) => profile.key);
    expect(keys).toContain("acme-frontier-9");
    expect(keys.filter((key) => key === curatedKey)).toHaveLength(1);
    expect(listed).toHaveLength(Object.keys(MODEL_PROFILES).length + 1);
  });

  test("the synthesis cache is dropped by the same call that drops models", () => {
    setLiveStateDouble([row()]);
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("acme");
    setLiveStateDouble([
      row({ dynamicProfile: dynamic({ family: "deepseek" }) }),
    ]);
    // Still the memoised answer until the one invalidation path runs.
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("acme");
    clearResolvedModelCache();
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("deepseek");
  });
});
