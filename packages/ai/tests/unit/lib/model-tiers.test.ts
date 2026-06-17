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
  test("flagship requires the flagship tier AND a passed gate", () => {
    const m3 = MODEL_PROFILES["minimax-m3"];
    expect(m3).toBeDefined();
    expect(isSelectableForTier(m3, "flagship")).toBe(true);
    // Right gate, wrong tier.
    expect(isSelectableForTier(m3, "utility")).toBe(false);
  });

  test("workhorse / utility do NOT require a gate — only the tier + enabled", () => {
    // gemini-3.5-flash is `pending` (failed flagship on zombie-rate) but lists
    // workhorse → selectable there, NOT in flagship.
    const gemini = MODEL_PROFILES["gemini-3.5-flash"];
    expect(gemini).toBeDefined();
    expect(gemini.assessment.evalGate.status).not.toBe("passed");
    expect(gemini.tiers).toContain("workhorse");
    expect(isSelectableForTier(gemini, "workhorse")).toBe(true);
    expect(isSelectableForTier(gemini, "flagship")).toBe(false);
  });

  test("a non-passed profile is never selectable for FLAGSHIP", () => {
    const pending = Object.values(MODEL_PROFILES).find(
      (p) =>
        p.assessment.evalGate.status !== "passed" &&
        p.tiers.includes("flagship"),
    );
    expect(pending).toBeDefined();
    expect(isSelectableForTier(pending!, "flagship")).toBe(false);
  });
});

describe("listSelectableProfilesForTier", () => {
  test("every listed profile is of that tier + enabled; flagship also requires passed", () => {
    for (const tier of TIERS) {
      for (const profile of listSelectableProfilesForTier(tier)) {
        expect(profile.tiers).toContain(tier);
        expect(profile.assessment.enabled).not.toBe(false);
        if (tier === "flagship") {
          expect(profile.assessment.evalGate.status).toBe("passed");
        }
      }
    }
  });

  test("flagship menu includes the chat default (minimax-m3)", () => {
    const keys = listSelectableProfilesForTier("flagship").map((p) => p.key);
    expect(keys).toContain("minimax-m3");
  });

  test("workhorse menu includes a non-gated model (gemini-3.5-flash)", () => {
    const keys = listSelectableProfilesForTier("workhorse").map((p) => p.key);
    expect(keys).toContain("gemini-3.5-flash");
  });

  test("utility menu excludes gpt-4o-mini (vision-fallback only)", () => {
    const keys = listSelectableProfilesForTier("utility").map((p) => p.key);
    expect(keys).not.toContain("gpt-4o-mini");
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

  test("a non-flagship (or gate-failed) pin → default + fallback flag", () => {
    // gpt-oss-20b is a passed utility model — not a selectable flagship.
    const result = resolveFlagshipProfileKey("gpt-oss-20b");
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
    const premium = MODEL_PROFILES["claude-opus-4.8"];
    expect(cheap).toBeDefined();
    expect(premium).toBeDefined();
    expect(costLevelFromProfile(cheap)).toBeLessThan(
      costLevelFromProfile(premium),
    );
  });
});

describe("display names", () => {
  test("known key resolves to a brand name; unknown falls back to the key", () => {
    expect(getModelDisplayName("minimax-m3")).toBe("MiniMax M3");
    expect(getModelDisplayName("totally-unknown")).toBe("totally-unknown");
  });
});
