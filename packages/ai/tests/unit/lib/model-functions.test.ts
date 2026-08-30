import { functionEligibility } from "@fretik/shared/model-registry/eligibility";
import { describe, expect, test } from "bun:test";
import { getModelDisplayName } from "../../../src/lib/model-registry/display";
import {
  FUNCTION_REPRESENTATIVE,
  MODEL_FUNCTION_KEYS,
  ROLE_FUNCTION,
  selectableForFunction,
  signalsForProfile,
} from "../../../src/lib/model-registry/functions";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import {
  recommendedProfileKeyForFunction,
  resolveFlagshipProfileKey,
} from "../../../src/lib/model-registry/resolve";
import { costLevelFromProfile } from "../../../src/services/model-metrics/cost-level";
import { FALLBACK_METRICS } from "../../../src/services/model-metrics/fallback";

/**
 * C8 — per-team / per-conversation tier selection. These pin the pure
 * selection logic the picker endpoint + the chat handler's flagship
 * resolution rely on. No Redis / DB / network here.
 */

describe("ROLE_FUNCTION", () => {
  test("covers every role binding — a gap serves the default in silence", () => {
    for (const role of Object.keys(ROLE_BINDINGS)) {
      expect(ROLE_FUNCTION[role as keyof typeof ROLE_FUNCTION]).toBeDefined();
    }
  });

  test("fallbacks and the page critic are automatic, never offered", () => {
    // A fallback a team could repoint onto its own primary is not redundancy,
    // and a cheaper critic would praise rather than fail loudly.
    expect(ROLE_FUNCTION["chat-fallback"]).toBe("auto");
    expect(ROLE_FUNCTION["vision-fallback"]).toBe("auto");
    expect(ROLE_FUNCTION["pre-extract-fallback"]).toBe("auto");
    expect(ROLE_FUNCTION["transform-fallback"]).toBe("auto");
    expect(ROLE_FUNCTION["page-review"]).toBe("auto");
  });

  test("the six roles that used to be pinned `fixed` are now team choices", () => {
    // Each was a constant standing in for a quality floor. The floor is now a
    // rule in `eligibility.ts`, so the choice can be offered without the risk.
    expect(ROLE_FUNCTION.vision).toBe("vision");
    expect(ROLE_FUNCTION["active-memory"]).toBe("recall");
    expect(ROLE_FUNCTION["memory-consolidate"]).toBe("memory");
    expect(ROLE_FUNCTION["memory-promote"]).toBe("memory");
    expect(ROLE_FUNCTION["tool-repair"]).toBe("quick-tasks");
    expect(ROLE_FUNCTION["page-build"]).toBe("pages");
  });

  test("every function has a representative whose role belongs to it", () => {
    for (const [fn, role] of Object.entries(FUNCTION_REPRESENTATIVE)) {
      expect(`${fn}:${ROLE_FUNCTION[role]}`).toBe(`${fn}:${fn}`);
    }
  });
});

describe("recommendedProfileKeyForFunction", () => {
  test("every function's default is CAPABLE of the function it serves", () => {
    // The invariant that keeps a threshold honest: a floor that excludes the
    // default it was written around is a floor that is wrong.
    //
    // Capability only, deliberately. `assessment.enabled` is a separate and
    // older decision — `gemini-3.7-flash` is cost-disabled for teams and still
    // serves `page-build`, because a binding resolves its profile directly.
    // Asserting selectability here would fail on a product choice rather than
    // on a threshold.
    for (const fn of MODEL_FUNCTION_KEYS) {
      const key = recommendedProfileKeyForFunction(fn);
      const profile = MODEL_PROFILES[key];
      expect(`${fn}:${profile !== undefined}`).toBe(`${fn}:true`);
      if (profile) {
        expect(
          `${fn}:${functionEligibility(fn, signalsForProfile(profile, undefined)).verdict}`,
        ).not.toBe(`${fn}:ineligible`);
      }
    }
  });

  test("a function whose default a team CAN pick offers it", () => {
    // The other half: when the default is selectable, the menu must contain it.
    for (const fn of MODEL_FUNCTION_KEYS) {
      const profile = MODEL_PROFILES[recommendedProfileKeyForFunction(fn)];
      if (!profile?.assessment.enabled) continue;
      expect(`${fn}:${selectableForFunction(profile, fn)}`).toBe(`${fn}:true`);
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
      (p) => !p.assessment.enabled,
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
    // blend: GLM-5.2 emits 42 791 output tokens per task against Gemini 3.7
    // Flash's 23 307, so the two must not rank alike even when priced alike.
    //
    // Held at ONE price through the override deliberately. This test used to
    // pin a live pair ("GLM has the cheaper headline yet costs more per turn")
    // and went red the day Flash's settled rate halved to $0.75/$3.75 — the
    // property held, the fixture did not. A price move must never be able to
    // turn this assertion into a tautology, nor break it.
    const glm = MODEL_PROFILES["glm-5.2"];
    const flash = MODEL_PROFILES["gemini-3.7-flash"];
    expect(glm).toBeDefined();
    expect(flash).toBeDefined();
    expect(glm.assessment.verbosity?.outputTokensPerTask).toBeGreaterThan(
      flash.assessment.verbosity?.outputTokensPerTask ?? 0,
    );
    const onePrice = {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
    };
    expect(costLevelFromProfile(glm, onePrice)).toBeGreaterThan(
      costLevelFromProfile(flash, onePrice),
    );
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
