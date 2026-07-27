import { describe, expect, test } from "bun:test";
import { getModelDisplayName } from "../../../src/lib/model-registry/display";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import {
  isSelectableForTier,
  listSelectableProfilesForTier,
  recommendedProfileKeyForTier,
  resolveFlagshipProfileKey,
  ROLE_TIER,
} from "../../../src/lib/model-registry/resolve";
import type { ModelTier } from "../../../src/lib/model-registry/types";
import { costLevelFromProfile } from "../../../src/services/model-metrics/cost-level";
import { FALLBACK_METRICS } from "../../../src/services/model-metrics/fallback";

/**
 * C8 — per-team / per-conversation tier selection. These pin the pure
 * selection logic the picker endpoint + the chat handler's flagship
 * resolution rely on. No Redis / DB / network here.
 */

const TIERS: readonly ModelTier[] = ["flagship", "workhorse", "utility"];

describe("ROLE_TIER", () => {
  test("covers every role binding", () => {
    for (const role of Object.keys(ROLE_BINDINGS)) {
      expect(ROLE_TIER[role as keyof typeof ROLE_TIER]).toBeDefined();
    }
  });

  test("fallbacks and vision are fixed (never user-selectable)", () => {
    expect(ROLE_TIER["chat-fallback"]).toBe("fixed");
    expect(ROLE_TIER.vision).toBe("fixed");
    expect(ROLE_TIER["vision-fallback"]).toBe("fixed");
    expect(ROLE_TIER.chat).toBe("flagship");
  });
});

describe("isSelectableForTier", () => {
  test("selectability is the tier plus `enabled` — nothing else", () => {
    const m3 = MODEL_PROFILES["minimax-m3"];
    expect(m3).toBeDefined();
    expect(isSelectableForTier(m3, "flagship")).toBe(true);
    // Right model, wrong tier.
    expect(isSelectableForTier(m3, "utility")).toBe(false);
  });

  test("the eval gate NO LONGER blocks selection, in any tier", () => {
    // The 2026-07-26 change: a profile with no gate evidence at all is still
    // offered to teams. This used to be false for `flagship`, which had frozen
    // the flagship menu at two models. Guards against the clause creeping back.
    const ungated = Object.values(MODEL_PROFILES).filter(
      (p) =>
        p.assessment.evalGate?.status !== "passed" &&
        p.assessment.enabled &&
        p.tiers.includes("flagship"),
    );
    expect(ungated.length).toBeGreaterThan(0);
    for (const profile of ungated) {
      expect(`${profile.key}:${isSelectableForTier(profile, "flagship")}`).toBe(
        `${profile.key}:true`,
      );
    }
  });

  test("`enabled: false` blocks every tier the profile lists", () => {
    const disabled = Object.values(MODEL_PROFILES).filter(
      (p) => !p.assessment.enabled,
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const profile of disabled) {
      for (const tier of profile.tiers) {
        expect(
          `${profile.key}:${tier}:${isSelectableForTier(profile, tier)}`,
        ).toBe(`${profile.key}:${tier}:false`);
      }
    }
  });

  test("every disabled profile explains itself", () => {
    // The picker renders disabled models with a tooltip keyed off this field —
    // a blank reason would render an unexplained dead card.
    for (const profile of Object.values(MODEL_PROFILES)) {
      if (profile.assessment.enabled) continue;
      expect(
        `${profile.key}:${profile.assessment.disabledReason ?? "MISSING"}`,
      ).not.toBe(`${profile.key}:MISSING`);
    }
  });
});

describe("listSelectableProfilesForTier", () => {
  test("every listed profile is of that tier and enabled", () => {
    for (const tier of TIERS) {
      for (const profile of listSelectableProfilesForTier(tier)) {
        expect(profile.tiers).toContain(tier);
        expect(profile.assessment.enabled).toBe(true);
      }
    }
  });

  test("flagship menu includes the chat default (minimax-m3)", () => {
    const keys = listSelectableProfilesForTier("flagship").map((p) => p.key);
    expect(keys).toContain("minimax-m3");
  });

  test("flagship menu offers real choice across families", () => {
    // The whole point of dropping the gate: breadth. Two options from one or
    // two vendors (the pre-2026-07-26 state) is a regression, not a menu.
    const profiles = listSelectableProfilesForTier("flagship");
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    expect(new Set(profiles.map((p) => p.family)).size).toBeGreaterThanOrEqual(
      3,
    );
  });

  test("every tier has at least one selectable option", () => {
    for (const tier of TIERS) {
      expect(`${tier}:${listSelectableProfilesForTier(tier).length > 0}`).toBe(
        `${tier}:true`,
      );
    }
  });
});

describe("recommendedProfileKeyForTier", () => {
  test("flagship recommendation is the chat code default", () => {
    expect(recommendedProfileKeyForTier("flagship")).toBe(
      ROLE_BINDINGS.chat.profileKey,
    );
  });

  test("every recommendation is itself selectable for its tier", () => {
    for (const tier of TIERS) {
      const key = recommendedProfileKeyForTier(tier);
      const profile = MODEL_PROFILES[key];
      expect(profile).toBeDefined();
      expect(isSelectableForTier(profile, tier)).toBe(true);
    }
  });
});

describe("resolveFlagshipProfileKey", () => {
  const def = ROLE_BINDINGS.chat.profileKey;

  test("null / undefined pin → default, no fallback flag", () => {
    expect(resolveFlagshipProfileKey(null)).toEqual({
      profileKey: def,
      fellBack: false,
    });
    expect(resolveFlagshipProfileKey(undefined)).toEqual({
      profileKey: def,
      fellBack: false,
    });
  });

  test("a valid flagship pin is honoured", () => {
    expect(resolveFlagshipProfileKey("minimax-m3")).toEqual({
      profileKey: "minimax-m3",
      fellBack: false,
    });
  });

  test("unknown key → default + fallback flag", () => {
    expect(resolveFlagshipProfileKey("does-not-exist")).toEqual({
      profileKey: def,
      fellBack: true,
    });
  });

  test("a non-flagship pin → default + fallback flag", () => {
    // gpt-oss-20b is a utility model — not a selectable flagship.
    const result = resolveFlagshipProfileKey("gpt-oss-20b");
    expect(result.profileKey).toBe(def);
    expect(result.fellBack).toBe(true);
  });

  test("a disabled flagship pin → default + fallback flag", () => {
    // `enabled: false` is now the ONLY thing that can reject a pin, so it has
    // to actually reject one.
    const disabled = Object.values(MODEL_PROFILES).find(
      (p) => !p.assessment.enabled && p.tiers.includes("flagship"),
    );
    expect(disabled).toBeDefined();
    const result = resolveFlagshipProfileKey(disabled!.key);
    expect(result.profileKey).toBe(def);
    expect(result.fellBack).toBe(true);
  });
});

describe("costLevelFromProfile", () => {
  test("is 0-100 for every profile", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      const level = costLevelFromProfile(profile);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(100);
    }
  });

  test("a cheaper model has a lower cost level than a premium one", () => {
    const cheap = MODEL_PROFILES["gpt-oss-20b"];
    const premium = MODEL_PROFILES["claude-opus-5"];
    expect(cheap).toBeDefined();
    expect(premium).toBeDefined();
    expect(costLevelFromProfile(cheap)).toBeLessThan(
      costLevelFromProfile(premium),
    );
  });

  test("verbosity, not headline price, drives the ranking", () => {
    // The reason `costLevelFromProfile` models a real turn instead of a 3:1
    // blend. GLM-5.2 has a CHEAPER headline than Gemini 3.6 Flash
    // ($0.67/$2.11 vs $1.50/$7.50) yet is the more verbose model by far
    // (42 791 vs 23 307 output tokens per task). A blended-price formula would
    // rank purely on the headline; this one must account for both.
    const glm = MODEL_PROFILES["glm-5.2"];
    const flash = MODEL_PROFILES["gemini-3.6-flash"];
    expect(glm).toBeDefined();
    expect(flash).toBeDefined();
    expect(glm.assessment.verbosity?.outputTokensPerTask).toBeGreaterThan(
      flash.assessment.verbosity?.outputTokensPerTask ?? 0,
    );
    // Cheap input still wins overall here — but only because the model prices
    // it that way, not because verbosity was ignored.
    expect(costLevelFromProfile(glm)).toBeLessThan(costLevelFromProfile(flash));
  });

  test("a model with no verbosity data is neither rewarded nor punished", () => {
    // Missing AA coverage must fall back to the fleet median, never to zero
    // output (which would make an unmeasured model look artificially cheap).
    const noVerbosity = Object.values(MODEL_PROFILES).filter(
      (p) => p.assessment.verbosity === undefined,
    );
    for (const profile of noVerbosity) {
      const level = costLevelFromProfile(profile);
      expect(`${profile.key}:${level > 0}`).toBe(`${profile.key}:true`);
    }
  });
});

describe("display names", () => {
  test("known key resolves to a brand name; unknown falls back to the key", () => {
    expect(getModelDisplayName("minimax-m3")).toBe("MiniMax M3");
    expect(getModelDisplayName("totally-unknown")).toBe("totally-unknown");
  });
});

/**
 * The hub's three headline gauges (capability / running cost / time to answer)
 * must ALWAYS render a value. They come from the metrics snapshot, which falls
 * back to `FALLBACK_METRICS` whenever Artificial Analysis is unreachable or the
 * `ARTIFICIAL_ANALYSIS_API_KEY` is unset — as it can be in a fresh environment.
 *
 * This exists because of a real prod symptom (2026-07-27): every model rendered
 * "Not measured". Two causes, both guarded here and in `refresh.ts` — a stale
 * snapshot under an unbumped cache key, and `timeToFirstAnswer` having no
 * fallback row while driving a headline gauge.
 */
describe("fallback metrics cover every headline gauge", () => {
  test("every profile has a fallback row", () => {
    // A model added without one shows blank gauges in any AA-less environment.
    for (const key of Object.keys(MODEL_PROFILES)) {
      expect(`${key}:${FALLBACK_METRICS[key] !== undefined}`).toBe(
        `${key}:true`,
      );
    }
  });

  test("no fallback row carries a zero or negative figure", () => {
    // AA returns 0 for "no data", not "instant" / "free" — copying that through
    // would render a model as the fastest in the fleet on missing data.
    for (const [key, row] of Object.entries(FALLBACK_METRICS)) {
      expect(`${key}:intelligence:${row.intelligence > 0}`).toBe(
        `${key}:intelligence:true`,
      );
      expect(`${key}:speed:${row.speed > 0}`).toBe(`${key}:speed:true`);
      expect(`${key}:ttfa:${row.timeToFirstAnswer > 0}`).toBe(
        `${key}:ttfa:true`,
      );
    }
  });

  test("no fallback row is left over from a removed profile", () => {
    for (const key of Object.keys(FALLBACK_METRICS)) {
      expect(`${key}:${MODEL_PROFILES[key] !== undefined}`).toBe(`${key}:true`);
    }
  });

  test("cost never falls back — it is always the real catalog price", () => {
    // `costLevel` is computed per request from the registry, so unlike the AA
    // axes it can never be blank. Pins that it stays that way.
    for (const profile of Object.values(MODEL_PROFILES)) {
      const level = costLevelFromProfile(profile);
      expect(Number.isFinite(level)).toBe(true);
      expect(level).toBeGreaterThan(0);
    }
  });
});
