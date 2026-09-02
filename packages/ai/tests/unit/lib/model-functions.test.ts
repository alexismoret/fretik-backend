import { functionEligibility } from "@fretik/shared/model-registry/eligibility";
import type { LiveModelState } from "@fretik/shared/model-registry/types";
import { afterEach, describe, expect, test } from "bun:test";
import { boundProfileKeys } from "../../../src/lib/model-registry/bound-roles";
import { getModelDisplayName } from "../../../src/lib/model-registry/display";
import {
  FUNCTION_REPRESENTATIVE,
  MODEL_FUNCTION_KEYS,
  ROLE_FUNCTION,
  selectableForFunction,
  signalsForProfile,
  unmetForFunction,
} from "../../../src/lib/model-registry/functions";
import {
  recommendedProfileKeyForFunction,
  resolveFlagshipProfileKey,
} from "../../../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import { costLevelFromProfile } from "../../../src/services/model-metrics/cost-level";
import { FALLBACK_METRICS } from "../../../src/services/model-metrics/fallback";
import {
  BOUND_ROWS,
  boundProfile,
  FLEET,
  installBoundFleet,
  profileOf,
  row,
} from "../../lib/live-fleet";
import { setLiveStateDouble } from "../../lib/live-state-double";

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
    installBoundFleet();
    for (const fn of MODEL_FUNCTION_KEYS) {
      const profile = boundProfile(recommendedProfileKeyForFunction(fn));
      expect(
        `${fn}:${functionEligibility(fn, signalsForProfile(profile, undefined)).verdict}`,
      ).not.toBe(`${fn}:ineligible`);
    }
    setLiveStateDouble();
  });

  test("a function whose default a team CAN pick offers it", () => {
    // The other half: when the default is selectable, the menu must contain it.
    installBoundFleet();
    for (const fn of MODEL_FUNCTION_KEYS) {
      const profile = boundProfile(recommendedProfileKeyForFunction(fn));
      if (!profile.assessment.enabled) continue;
      expect(`${fn}:${selectableForFunction(profile, fn)}`).toBe(`${fn}:true`);
    }
    setLiveStateDouble();
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
    installBoundFleet();
    expect(resolveFlagshipProfileKey("minimax-m3")).toEqual({
      profileKey: "minimax-m3",
      fellBack: false,
    });
    setLiveStateDouble();
  });

  test("unknown key → default + fallback flag", () => {
    expect(resolveFlagshipProfileKey("does-not-exist")).toEqual({
      profileKey: def,
      fellBack: true,
    });
  });

  test("a non-flagship pin → default + fallback flag", () => {
    // gpt-oss-20b is a utility model — not a selectable flagship. On a cold
    // snapshot (the state this test has always actually run under): the
    // synthetic fleet's fixture rows carry no utility marking, so with rows
    // present the pin would be honoured.
    setLiveStateDouble();
    const result = resolveFlagshipProfileKey("gpt-oss-20b");
    expect(result.profileKey).toBe(def);
    expect(result.fellBack).toBe(true);
  });

  test("a disabled flagship pin → default + fallback flag", () => {
    // `enabled: false` is now the ONLY thing that can reject a pin, so it has
    // to actually reject one. Enablement lives on the row, so this installs a
    // fleet with one disabled member rather than hunting for one in a list.
    installBoundFleet();
    setLiveStateDouble([
      ...BOUND_ROWS,
      row({ profileKey: "too-dear", enabled: false, disabledReason: "cost" }),
    ]);
    const result = resolveFlagshipProfileKey("too-dear");
    expect(result.profileKey).toBe(def);
    expect(result.fellBack).toBe(true);
    setLiveStateDouble();
  });
});

describe("costLevelFromProfile", () => {
  test("is 0-100 for every profile", () => {
    for (const profile of FLEET) {
      const level = costLevelFromProfile(profile);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(100);
    }
  });

  test("a cheaper model has a lower cost level than a premium one", () => {
    expect(costLevelFromProfile(boundProfile("gpt-oss-20b"))).toBeLessThan(
      costLevelFromProfile(
        profileOf({ pricing: { inputPerMTok: 15, outputPerMTok: 75 } }),
      ),
    );
  });

  test("the cache discount is priced, and only where a cached rate is quoted", () => {
    // The half of the cost model that survived verbosity's removal, and the
    // one that dominates a turn: the static prefix is re-sent on every step, so
    // whether the vendor discounts a cache read is worth more than its headline
    // rate. A KNOWN cached rate is the evidence caching applies — the upstream
    // publishes one only where it discounts.
    const price = { inputPerMTok: 3, outputPerMTok: 15 };
    const uncached = profileOf({ pricing: price });
    const cached = profileOf({
      pricing: { ...price, cacheReadPerMTok: 0.3 },
    });
    expect(costLevelFromProfile(cached)).toBeLessThan(
      costLevelFromProfile(uncached),
    );
  });

  test("every model is priced — the axis can never be blank", () => {
    // Verbosity used to scale this per model from a hand-curated figure, which
    // covered 22 of 139 models and left the rest on the fleet median anyway. No
    // API publishes it, so the whole fleet now shares one output estimate;
    // measured impact of the change is at most 4 points of 100, because output
    // is under-weighted ~4× regardless (see `cost-level.ts`).
    for (const profile of FLEET) {
      const level = costLevelFromProfile(profile);
      expect(`${profile.key}:${level > 0}`).toBe(`${profile.key}:true`);
    }
  });
});

describe("unmetForFunction", () => {
  /**
   * `selectableForFunction` DECIDES, `unmetForFunction` EXPLAINS, and the two
   * must never disagree. A greyed row that says "not compatible" and nothing
   * more reads as an arbitrary product decision; the same row saying "its
   * window is 262k and this job needs none smaller than 256k" is a fact a team
   * can act on.
   */
  afterEach(() => setLiveStateDouble());

  test("says nothing about a model the function accepts", () => {
    installBoundFleet();
    const profile = boundProfile("gpt-5.6-luna");
    expect(selectableForFunction(profile, "vision")).toBe(true);
    expect(unmetForFunction(profile, "vision")).toEqual([]);
  });

  test("names the hard capability gate a text-only model fails", () => {
    installBoundFleet();
    const profile = boundProfile("minimax-m3");
    expect(selectableForFunction(profile, "vision")).toBe(false);
    expect(unmetForFunction(profile, "vision")).toContainEqual({
      rules: [{ kind: "modality", modality: "image" }],
    });
  });

  test("agrees with the verdict: something unmet means unselectable", () => {
    // The invariant that keeps the explanation honest across the whole fleet.
    installBoundFleet();
    for (const key of BOUND_ROWS.map((r) => r.profileKey)) {
      const profile = boundProfile(key);
      for (const fn of MODEL_FUNCTION_KEYS) {
        if (unmetForFunction(profile, fn).length > 0) {
          expect(selectableForFunction(profile, fn)).toBe(false);
        }
      }
    }
  });

  test("carries no host name — it is thresholds, not routes", () => {
    // The same agnosticism `serving` is held to: `unmet` travels beside a pool
    // whose hosts are named two fields away.
    installBoundFleet();
    const json = JSON.stringify(
      MODEL_FUNCTION_KEYS.map((fn) =>
        unmetForFunction(boundProfile("deepseek-v4-flash"), fn),
      ),
    ).toLowerCase();
    for (const host of ["deepinfra", "baseten", "venice", "fireworks"]) {
      expect(json).not.toContain(host);
    }
  });
});

/**
 * What a model is CALLED now comes from the catalogue serving it, not from a
 * hand-written table. The table it replaced held 22 lines, so 117 of the 139
 * live models rendered as their raw slug in the hub.
 */
/** A live row carrying nothing but the catalogue's name and maker. */
const namedRow = (
  profileKey: string,
  displayName: string,
  family = "acme",
): LiveModelState => ({
  profileKey,
  status: "published",
  transport: "openrouter",
  enabled: true,
  disabledReason: null,
  modelIds: { openrouter: profileKey },
  providerPool: {},
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 128_000,
  effectiveMaxOutput: null,
  pricing: { inputPerMTok: 1, outputPerMTok: 2 },
  creditMultiplier: 1,
  health: "healthy",
  healthScore: 90,
  policyReport: null,
  endpointStats: [],
  aaMetrics: null,
  aaSlug: null,
  releasedAt: null,
  dynamicProfile: {
    displayName,
    family,
    contextLength: 128_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["tools"],
    supportsReasoning: false,
    supportsTools: true,
    derivedFrom: { source: "openrouter", at: "2026-08-30T03:00:00.000Z" },
  },
  syncedAt: new Date("2026-08-30T03:00:00.000Z"),
  boundRoles: [],
  source: "sync",
});

describe("display names", () => {
  afterEach(() => {
    setLiveStateDouble();
  });

  test("the catalogue's own name wins", () => {
    setLiveStateDouble([namedRow("minimax-m3", "MiniMax M3")]);
    expect(getModelDisplayName("minimax-m3")).toBe("MiniMax M3");
  });

  test("the vendor prefix is stripped", () => {
    // The catalogues disagree on whether to add one — `"Claude Sonnet 4.5"`
    // bare beside `"OpenAI: GPT-5.6 Luna Pro"` on the same fetch — and the card
    // already carries the vendor's mark, so the prefix says it twice.
    setLiveStateDouble([
      namedRow("luna-pro", "OpenAI: GPT-5.6 Luna Pro", "openai"),
      // Folded on both sides: the catalogue writes `Z.ai`, the owner is `z-ai`.
      namedRow("glm", "Z.ai: GLM 5.2", "z-ai"),
    ]);
    expect(getModelDisplayName("luna-pro")).toBe("GPT-5.6 Luna Pro");
    expect(getModelDisplayName("glm")).toBe("GLM 5.2");
  });

  test("a name that merely CONTAINS a colon keeps it", () => {
    // The regression this pins: a rule that stripped by PUNCTUATION renamed
    // this model "The Reckoning". The prefix has to name the maker.
    setLiveStateDouble([
      namedRow("verbose", "Nemotron 3: The Reckoning", "nvidia"),
    ]);
    expect(getModelDisplayName("verbose")).toBe("Nemotron 3: The Reckoning");
  });

  test("nothing described it yet → the key, spaced and capitalised", () => {
    // The honest fallback, and deliberately NOT the rule: the key is a slug
    // that has already lost the version dots (`qwen3-5-flash` cannot become
    // "Qwen 3.5 Flash") and the vendor casing ("Glm" for GLM).
    expect(getModelDisplayName("totally-unknown")).toBe("Totally Unknown");
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
  test("every model an internal role depends on has a fallback row", () => {
    // A bound model with no fallback row shows blank gauges in any AA-less
    // environment. It cannot be asserted over the whole fleet any more — the
    // fleet is 139 rows the sync discovered, and hand-writing a fallback row
    // for each would be the curated registry again, under another name.
    for (const key of boundProfileKeys()) {
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

  test("cost never falls back — it is always priced from the row", () => {
    // `costLevel` is computed per request from the row's own pricing, so unlike
    // the AA axes it can never be blank. Pins that it stays that way.
    for (const profile of FLEET) {
      const level = costLevelFromProfile(profile);
      expect(Number.isFinite(level)).toBe(true);
      expect(level).toBeGreaterThan(0);
    }
  });
});
