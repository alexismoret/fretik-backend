import { reasoningLevelSchema } from "@fretik/shared/schemas/reasoning";
import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import {
  createOrphanThinkStreamStripper,
  effectiveReasoningLevel,
  getProfileForRole,
  isSelectableForTier,
  reasoningParamForProfile,
  selectableReasoningLevels,
  settingsForRole,
  stripOrphanThinkTags,
} from "../../../src/lib/model-registry/resolve";
import {
  REASONING_LEVELS,
  supportsParameter,
  type ModelRole,
  type ModelTier,
} from "../../../src/lib/model-registry/types";
import { shouldInjectCacheControl } from "../../../src/lib/openrouter-cache";

/**
 * C1 invariant: the registry is a refactor with ZERO behaviour change.
 * These tests pin (a) the request settings byte-for-byte against the
 * historical per-role objects from `lib/openrouter.ts`, and (b) the
 * default model ids against what prod served before the registry
 * existed. Any intentional change here must go through the C3
 * promotion gate first.
 *
 * Gated change 2026-06-12: `chat` flipped to minimax-m3 through the
 * C3 promotion gate (run 3aeec9d1-… vs the M2.7 baseline). M3 carries
 * the documented `zdr: false` exemption, so the chat envelope pin
 * tracks it; every other binding keeps the historical envelope.
 */

/**
 * The vetted upstream pool for deepseek-v4-flash, asserted on every role that
 * carries it. Pinned here because widening it is a QUALITY change, not a
 * routing tweak: membership is decided by whether an upstream returns the
 * answer INTACT when the response ends in a tool call, whether it populates the
 * implicit prompt cache (a miss bills ~4.6× per turn), and whether its reasoning
 * converges — none of which `sort: "throughput"` can see. See the profile for
 * the 2026-08-13 measurements and the per-provider exclusion reasons.
 *
 * Together was REMOVED on 2026-08-13 for truncating answers mid-sentence at the
 * tool-call boundary; Fireworks and CoreWeave replaced it once their own
 * exclusions (HTTP 429, no cache) re-benched clean.
 */
const VETTED_DEEPSEEK_UPSTREAMS = [
  "baseten",
  "fireworks",
  "venice",
  "coreweave",
  "deepinfra",
];

describe("settingsForRole — parity with historical settings objects", () => {
  test("chat-fallback carries minimax-m3's own envelope, not the historical one", () => {
    // Rebound to minimax-m3 on 2026-08-02 so the fallback shares neither
    // family nor upstream with the DeepSeek primary. It therefore brings M3's
    // pinned 5 000-token reasoning budget and Novita pin rather than the
    // 1 500 / unpinned envelope deepseek-v4-pro used to produce here.
    expect(
      settingsForRole(
        ROLE_BINDINGS["chat-fallback"],
        getProfileForRole("chat-fallback"),
      ),
    ).toEqual({
      provider: { require_parameters: true, zdr: true, order: ["Novita"] },
      reasoning: { enabled: true, max_tokens: 5_000 },
      usage: { include: true },
    });
  });

  test("dispatch-cheap carries the deepseek-v4-flash vetted pool + throughput sort", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["dispatch-cheap"],
        getProfileForRole("dispatch-cheap"),
      ),
    ).toEqual({
      provider: {
        require_parameters: true,
        zdr: true,
        only: VETTED_DEEPSEEK_UPSTREAMS,
        sort: "throughput",
      },
      reasoning: { enabled: true, max_tokens: 1_500 },
      usage: { include: true },
    });
  });

  // The two pre-extract roles no longer share one envelope, and that is the
  // point: the kind carries the PROFILE's pool on top of its own role-level
  // sort. Bound to deepseek-v4-flash, `pre-extract` used to run on the full ZDR
  // pool because this kind dropped `only`/`ignore` — reaching the upstreams the
  // profile excludes on measurement.
  test("preextract carries the bound profile's vetted pool + the role's throughput sort", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract"],
        getProfileForRole("pre-extract"),
      ),
    ).toEqual({
      reasoning: { effort: "minimal" },
      provider: {
        require_parameters: true,
        zdr: true,
        only: VETTED_DEEPSEEK_UPSTREAMS,
        sort: "throughput",
      },
    });
    // gpt-oss-120b declares no pool, so its envelope is unchanged — a profile
    // without filters must not gain any.
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract-fallback"],
        getProfileForRole("pre-extract-fallback"),
      ),
    ).toEqual({
      reasoning: { effort: "minimal" },
      provider: { require_parameters: true, zdr: true, sort: "throughput" },
    });
  });

  // `only` is the recall judge's LATENCY guard, and it is pinned here because
  // widening it silently re-admits an upstream whose spread reaches the 15 s
  // recall timeout — where the cost is a turn with no memory block at all, not
  // a slow turn. Measured 2026-08 over 200 judge calls: DeepInfra mean 4.6 s /
  // max 9.7 s against Cerebras 1.0 / 4.9 and Groq 2.1 / 4.5.
  test("active-memory envelope = the P5-bis recall envelope (throughput sort + quality floor + latency shortlist)", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["active-memory"],
        getProfileForRole("active-memory"),
      ),
    ).toEqual({
      provider: {
        require_parameters: true,
        zdr: true,
        sort: "throughput",
        ignore: ["fireworks"],
        quantizations: ["bf16", "fp16", "unknown"],
        only: ["cerebras", "groq"],
      },
      // `enabled: true` arrived when the two memory kinds started resolving
      // reasoning THROUGH the profile (`reasoningParamForProfile`) instead of
      // hardcoding `{ effort }`. For an effort-style family like gpt-oss the
      // pair is semantically the same switch; the change exists so that
      // `max-tokens`-style profiles stop receiving an `effort` their pool
      // ignores, which ran them with unbounded reasoning.
      reasoning: { enabled: true, effort: "medium" },
    });
  });

  test("bare roles carry their profile's provider policy (zdr always; sort when the profile asks), WITHOUT require_parameters", () => {
    // The reasoning/usage envelope is left to the call site, but the
    // provider block (zdr especially) must never be dropped. Unlike `chat`,
    // bare roles omit `require_parameters` — they never tool-call, and the
    // flag would exclude a pinned model's only ZDR endpoint when it omits a
    // sent parameter (Gemini's Vertex route doesn't advertise `temperature`).
    const bareNoSort = { provider: { zdr: true } };
    expect(
      settingsForRole(
        ROLE_BINDINGS["cheap-tasks"],
        getProfileForRole("cheap-tasks"),
      ),
    ).toEqual(bareNoSort);
    expect(
      settingsForRole(ROLE_BINDINGS.vision, getProfileForRole("vision")),
    ).toEqual(bareNoSort);
    expect(
      settingsForRole(
        ROLE_BINDINGS["vision-fallback"],
        getProfileForRole("vision-fallback"),
      ),
    ).toEqual(bareNoSort);
    // A throughput-sorted profile with a vetted pool (deepseek-v4-flash)
    // surfaces both `sort` and `only`.
    expect(
      settingsForRole(
        ROLE_BINDINGS["compaction-summarizer"],
        getProfileForRole("compaction-summarizer"),
      ),
    ).toEqual({
      provider: {
        zdr: true,
        sort: "throughput",
        only: VETTED_DEEPSEEK_UPSTREAMS,
      },
    });
  });

  // REGRESSION GUARD, and the reason this test is worth its weight: `order` and
  // `sort` do not compose — OpenRouter consults the pin first, so a profile
  // carrying both routes unsorted. deepseek-v4-flash shipped exactly that from
  // 2026-08-02 to 2026-08-05, which pinned every agent turn to DeepInfra and
  // made its declared throughput sort dead config. Measured on a 4 096-token
  // generation, that pin was the SLOWEST working upstream in the pool: 67 tok/s
  // and 62.0s, against BaseTen's 283 tok/s and 14.9s.
  test("chat routes on live throughput within the vetted pool — never on a pin", () => {
    const chat = settingsForRole(ROLE_BINDINGS.chat, getProfileForRole("chat"));
    expect(chat?.provider).toEqual({
      require_parameters: true,
      zdr: true,
      only: VETTED_DEEPSEEK_UPSTREAMS,
      sort: "throughput",
    });
    expect(chat?.provider).not.toHaveProperty("order");
  });

  test("transform runs ZDR + throughput-sorted over the vetted pool (deepseek-v4-flash policy)", () => {
    expect(
      settingsForRole(ROLE_BINDINGS.transform, getProfileForRole("transform")),
    ).toEqual({
      provider: {
        zdr: true,
        sort: "throughput",
        only: VETTED_DEEPSEEK_UPSTREAMS,
      },
    });
  });
});

describe("role bindings — default model ids pinned (chat: gated M3 flip)", () => {
  const expectedIds: Record<ModelRole, string> = {
    chat: "deepseek/deepseek-v4-flash-0731",
    "chat-fallback": "minimax/minimax-m3",
    // Workflow executor defaults to the chat profile (reliability first).
    workflow: "deepseek/deepseek-v4-flash-0731",
    "dispatch-cheap": "deepseek/deepseek-v4-flash-0731",
    "pre-extract": "deepseek/deepseek-v4-flash-0731",
    "pre-extract-fallback": "openai/gpt-oss-120b",
    // P5-bis (2026-07): 120b @ medium = 16/16 recall evals; 20b unstable.
    // Stays on gpt-oss while the three WRITE roles below moved: it is the only
    // memory role on a turn's hot path, behind a 15 s ceiling, and
    // deepseek-v4-flash runs at 40-60 TPS.
    "active-memory": "openai/gpt-oss-120b",
    // The write path moved to deepseek-v4-flash on 2026-08-04: memory-eval
    // 15/16 against gpt-oss 13/16 at TEN repeats, with the three cases gpt-oss
    // lost being the ones that write permanent rows (see the rationale on the
    // bindings themselves). Re-pin these three only against another 10-repeat
    // run — at 3 repeats this suite reported 16/16 while four cases were broken.
    "memory-extract": "deepseek/deepseek-v4-flash-0731",
    "memory-distill": "deepseek/deepseek-v4-flash-0731",
    "compaction-summarizer": "deepseek/deepseek-v4-flash-0731",
    "cheap-tasks": "openai/gpt-oss-20b",
    // ONE file-capable model backs both the `vision` tool and the `extract`
    // engine (no separate extraction role) — 3.5-flash-lite since 2026-07-25
    // (5×/3× cheaper, 12/12 full-recall free-form replays), cheap 3.1-lite
    // fallback. See ROLE_BINDINGS.vision.
    vision: "google/gemini-3.5-flash-lite",
    "vision-fallback": "google/gemini-3.1-flash-lite",
    // Its own role, not `vision`'s: judging whether a screen was designed is a
    // different job from reading a document. Left Gemini on 2026-08-19 when the
    // BUILDER landed there — the two may never share a family, or the critic
    // reviews its own work (see both bindings).
    "page-review": "openai/gpt-5.6-luna",
    // Its own role since 2026-08-18. Before that the page BUILDER resolved
    // `resolveModel("chat")` at module load, so no pin — not the team's
    // flagship, not the eval header — could reach it, and every page the
    // product ever generated came from the code default. Repointed 2026-08-19
    // on a neutral-judge A/B (the control failed to save a page at all on the
    // canonical case); pinned here so the next move is a deliberate edit with a
    // run behind it, exactly like the critic above.
    "page-build": "google/gemini-3.7-flash",
    transform: "deepseek/deepseek-v4-flash-0731",
    "transform-fallback": "google/gemini-3.7-flash",
    "tool-repair": "openai/gpt-oss-120b",
    // Stayed on gpt-oss: deepseek runs away on reasoning here (see binding).
    "memory-consolidate": "openai/gpt-oss-120b",
    // Split out of `memory-consolidate` — the two tasks that shared that role
    // want opposite models (10/10 vs 6/10 on the over-generalization guard).
    "memory-promote": "deepseek/deepseek-v4-flash-0731",
  };

  for (const [role, id] of Object.entries(expectedIds)) {
    test(`${role} → ${id}`, () => {
      expect(getProfileForRole(role as ModelRole).catalog.id).toBe(id);
    });
  }

  test("cache wrapping mirrors the historical wiring", () => {
    const wrapped: ModelRole[] = [
      "chat",
      "chat-fallback",
      "workflow",
      "dispatch-cheap",
      "pre-extract",
      "pre-extract-fallback",
      // The builder is a multi-step agent replaying a byte-stable system
      // prompt on every step — the same shape the chat roles wrap for, and the
      // reason its binding declares the chat envelope rather than `bare`.
      "page-build",
    ];
    for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
      expect(binding.wrapCache).toBe(wrapped.includes(role as ModelRole));
    }
  });

  test("the page builder and its critic never share a family", () => {
    // The critic exists to catch what the builder cannot see in its own work,
    // and a model asked to grade its own family praises it — the documented
    // failure the role was created around. Both bindings carried that rule in
    // prose and it still had to be remembered by hand on 2026-08-19, when the
    // builder moved onto the critic's model. Cheaper as an assertion.
    const builder = MODEL_PROFILES[ROLE_BINDINGS["page-build"].profileKey];
    const critic = MODEL_PROFILES[ROLE_BINDINGS["page-review"].profileKey];
    expect(builder).toBeDefined();
    expect(critic).toBeDefined();
    expect(critic.family).not.toBe(builder.family);
  });
});

describe("registry integrity", () => {
  test("every binding points at an existing profile", () => {
    for (const binding of Object.values(ROLE_BINDINGS)) {
      expect(MODEL_PROFILES[binding.profileKey]).toBeDefined();
    }
  });

  test("profile keys are coherent and OpenRouter ids unique", () => {
    const ids = new Set<string>();
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      expect(profile.key).toBe(key);
      expect(ids.has(profile.catalog.id)).toBe(false);
      ids.add(profile.catalog.id);
    }
  });

  test("every tier is covered by at least one profile", () => {
    // The registry is pruned for profitability — a family need NOT cover all
    // three tiers (e.g. MiniMax ships only its flagship M3). The picker-
    // relevant invariant is that each tier has at least one option overall.
    // A profile may list MORE THAN ONE tier (multi-tier), so flatMap.
    const tiers: ModelTier[] = ["flagship", "workhorse", "utility"];
    const covered = new Set<ModelTier>(
      Object.values(MODEL_PROFILES).flatMap((p) => p.tiers),
    );
    for (const tier of tiers) {
      expect(`${tier}:${covered.has(tier)}`).toBe(`${tier}:true`);
    }
  });

  test("nativeInput activation is a subset of catalog facts (C5)", () => {
    // The product may only send a modality natively when the model truly
    // accepts it upstream. The catalog is the hard ceiling; nativeInput is
    // the (eval-gated) product decision under it.
    for (const profile of Object.values(MODEL_PROFILES)) {
      const { nativeInput } = profile.assessment;
      const modalities = profile.catalog.inputModalities;
      if (nativeInput.image) expect(modalities).toContain("image");
      if (nativeInput.video) expect(modalities).toContain("video");
      if (nativeInput.audio) expect(modalities).toContain("audio");
      if (nativeInput.fileMimeTypes.length > 0) {
        expect(modalities).toContain("file");
      }
    }
  });

  test("native input is activated wherever the catalog allows it", () => {
    // Replaces the old frozen allow-list of nine profile keys, which pinned
    // WHICH models may read an attachment and so turned every registry
    // addition into a test edit — and had left most of the fleet routing
    // images through the `vision` tool despite accepting them natively.
    //
    // The rule is now derived: if a model accepts a visual modality upstream,
    // we send it natively. `audio` is the one deliberate exception (no call
    // site emits audio parts yet), asserted separately below.
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      const { nativeInput } = profile.assessment;
      const catalog = profile.catalog.inputModalities;
      for (const modality of ["image", "video"] as const) {
        expect(`${key}:${modality}:${nativeInput[modality]}`).toBe(
          `${key}:${modality}:${catalog.includes(modality)}`,
        );
      }
      expect(`${key}:pdf:${nativeInput.fileMimeTypes.join(",")}`).toBe(
        `${key}:pdf:${catalog.includes("file") ? "application/pdf" : ""}`,
      );
    }
  });

  test("audio is inactive everywhere, even where the catalog allows it", () => {
    // Five profiles accept audio upstream. Nothing in the product produces an
    // audio part, so activating it would ship untested surface — this guards
    // an accidental flip until there is a call site and eval evidence.
    const audioCapable = Object.values(MODEL_PROFILES).filter((p) =>
      p.catalog.inputModalities.includes("audio"),
    );
    expect(audioCapable.length).toBeGreaterThan(0);
    for (const profile of audioCapable) {
      expect(`${profile.key}:${profile.assessment.nativeInput.audio}`).toBe(
        `${profile.key}:false`,
      );
    }
  });

  test("every activated modality declares a recency limit", () => {
    // `prepareModelMessages` keeps the N most-recent native parts per modality
    // and degrades older ones to tool-mediated. Without a limit a long
    // conversation re-sends every image it ever saw, every turn.
    for (const profile of Object.values(MODEL_PROFILES)) {
      const { nativeInput } = profile.assessment;
      const { limits } = nativeInput;
      if (nativeInput.image) {
        expect(
          `${profile.key}:images:${limits?.maxImagesPerRequest ?? 0}`,
        ).not.toBe(`${profile.key}:images:0`);
      }
      if (nativeInput.video) {
        expect(
          `${profile.key}:videos:${limits?.maxVideosPerRequest ?? 0}`,
        ).not.toBe(`${profile.key}:videos:0`);
      }
      if (nativeInput.fileMimeTypes.length > 0) {
        expect(
          `${profile.key}:files:${limits?.maxFilesPerRequest ?? 0}`,
        ).not.toBe(`${profile.key}:files:0`);
      }
    }
  });

  test("the applied chat / workflow defaults carry passing eval evidence", () => {
    // THE replacement for the old flagship selection gate. Selection is now
    // governed by `enabled` alone, so evals guard exactly one thing: which
    // model actually serves by default. Swapping `ROLE_BINDINGS.chat` without
    // a gate run must fail CI.
    for (const role of ["chat", "workflow"] as const) {
      const binding = ROLE_BINDINGS[role];
      const profile = MODEL_PROFILES[binding.profileKey];
      expect(profile).toBeDefined();
      expect(
        `${role}:${profile.assessment.evalGate?.status ?? "MISSING"}`,
      ).toBe(`${role}:passed`);
    }
  });

  test("steerability is derived from the catalog, not hand-listed", () => {
    // Sanity on the derivation itself: neither empty nor everything, or the
    // rule is silently degenerate and every picker would look the same.
    const steerable = Object.values(MODEL_PROFILES).filter(
      (profile) => selectableReasoningLevels(profile).length > 0,
    );
    expect(steerable.length).toBeGreaterThan(0);
    expect(steerable.length).toBeLessThan(Object.keys(MODEL_PROFILES).length);
  });

  test("a profile never defaults to a reasoning level upstream rejects", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      const { style, defaultLevel } = profile.assessment.reasoning;
      const catalogReasoning = profile.catalog.reasoning;
      // Budget-style profiles send `max_tokens`, not an effort string, so the
      // effort ladder does not constrain them.
      if (style !== "effort") continue;
      // Reasoning that cannot be switched off must never default to `none`.
      if (catalogReasoning?.mandatory === true) {
        expect(`${profile.key}:${defaultLevel}`).not.toBe(
          `${profile.key}:none`,
        );
      }
      const supported = catalogReasoning?.supportedEfforts;
      if (supported === undefined || defaultLevel === "none") continue;
      expect(`${profile.key}:${supported.includes(defaultLevel)}`).toBe(
        `${profile.key}:true`,
      );
    }
  });

  test("cache strategy agrees with the cache-control middleware patterns", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      expect(shouldInjectCacheControl(profile.catalog.id)).toBe(
        profile.assessment.cache.strategy === "explicit-breakpoints",
      );
    }
  });

  test("supportsParameter reads the catalog list", () => {
    const m3 = MODEL_PROFILES["minimax-m3"];
    expect(m3).toBeDefined();
    if (!m3) return;
    expect(supportsParameter(m3, "tools")).toBe(true);
    // structured_outputs is absent from the M3 parameter list (unlike M2.7).
    expect(supportsParameter(m3, "structured_outputs")).toBe(false);
  });
});

/**
 * The user-facing thinking-depth picker (2026-07-27). It replaced the model
 * selector in the prompt bar, so what it offers has to be exactly what the
 * serving model honours — an inert control is worse than no control.
 */
describe("thinking depth — what a user may actually request", () => {
  test("the API's level enum matches the registry's, value for value", () => {
    // Two declarations exist on purpose: @fretik/shared needs VALUES at the
    // HTTP + DB boundary and must not import the registry (it ships inside the
    // Trigger.dev bundle). A divergence would let the API accept a level the
    // registry cannot map to a wire parameter, so pin them together.
    expect([...reasoningLevelSchema.options].sort()).toEqual(
      [...REASONING_LEVELS].sort(),
    );
  });

  test("only a real ladder offers a choice, whatever the wire style", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      const levels = selectableReasoningLevels(profile);
      // Never a single dead option, and never a level upstream rejects.
      expect(levels.length === 0 || levels.length > 1).toBe(true);
      const supported = profile.catalog.reasoning?.supportedEfforts ?? [];
      for (const level of levels) {
        expect(`${profile.key}:${supported.includes(level)}`).toBe(
          `${profile.key}:true`,
        );
      }
      // Non-reasoning models expose nothing at all.
      if (profile.assessment.reasoning.style === "none") {
        expect(`${profile.key}:${levels.length}`).toBe(`${profile.key}:0`);
      }
    }
  });

  test("a budget-style model with a ladder still offers its levels", () => {
    // The style is NOT the gate. DeepSeek V4 is deliberately `max-tokens` (its
    // 4:1 reasoning ratio needs a ceiling) yet documented as answering to the
    // level, which selects the budget from the shared table. An earlier version
    // of this rule keyed off `style === "effort"` and silently took that away.
    const deepseek = MODEL_PROFILES["deepseek-v4-pro"];
    expect(deepseek?.assessment.reasoning.style).toBe("max-tokens");
    expect(selectableReasoningLevels(deepseek).length).toBeGreaterThan(1);
  });

  test("a pinned reasoning budget never coexists with an offered ladder", () => {
    // `reasoningParamForProfile` lets a per-profile `maxTokens` beat the
    // level→budget table, so offering levels alongside one would be a control
    // that changes nothing on the wire.
    for (const profile of Object.values(MODEL_PROFILES)) {
      if (profile.assessment.reasoning.maxTokens === undefined) continue;
      expect(
        `${profile.key}:${selectableReasoningLevels(profile).length}`,
      ).toBe(`${profile.key}:0`);
    }
  });

  test("a mandatory reasoner never offers to switch reasoning off", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      if (profile.catalog.reasoning?.mandatory !== true) continue;
      expect(
        `${profile.key}:${selectableReasoningLevels(profile).includes("none")}`,
      ).toBe(`${profile.key}:false`);
    }
  });

  test("every flagship a team can pick either steers or explains itself", () => {
    // Not an assertion that all of them steer — the applied default (M3) does
    // not. This pins that the menu is not ENTIRELY inert, so the control is
    // reachable by switching model, and documents which side each model is on.
    const flagship = Object.values(MODEL_PROFILES).filter((p) =>
      isSelectableForTier(p, "flagship"),
    );
    expect(flagship.length).toBeGreaterThan(1);
    expect(
      flagship.filter((p) => selectableReasoningLevels(p).length > 0).length,
    ).toBeGreaterThan(0);
  });

  describe('"No thinking" actually switches thinking off', () => {
    // Measured on GPT-5.6 Luna 2026-07-27: omitting the reasoning param leaves
    // 13 reasoning tokens (Azure's own default); `{ enabled: false }` and
    // `{ effort: "none" }` both leave 0. A user who picks "No thinking" must get
    // the off-switch, not the omission.
    const luna = MODEL_PROFILES["gpt-5.6-luna"];
    const flashLite = MODEL_PROFILES["gemini-3.1-flash-lite"];

    test("an explicit `none` sends the off-switch", () => {
      expect(luna && reasoningParamForProfile(luna, "none")).toEqual({
        enabled: false,
        effort: "none",
      });
    });

    test("a profile that merely DEFAULTS to none stays byte-identical", () => {
      // gemini-3.1-flash-lite's default IS `none`; its envelope must not gain a
      // parameter it never sent, or every cached prefix on that path changes.
      expect(flashLite?.assessment.reasoning.defaultLevel).toBe("none");
      expect(flashLite && reasoningParamForProfile(flashLite)).toBeUndefined();
    });

    test("a model with no reasoning support still sends nothing", () => {
      // `require_parameters` would empty the pool on a param it can't advertise.
      for (const profile of Object.values(MODEL_PROFILES)) {
        if (profile.assessment.reasoning.style !== "none") continue;
        expect(reasoningParamForProfile(profile, "none")).toBeUndefined();
        expect(reasoningParamForProfile(profile, "high")).toBeUndefined();
      }
    });
  });

  describe("effectiveReasoningLevel", () => {
    // GLM-5.2's ladder is xhigh/high with `high` as its default — the smallest
    // real ladder in the fleet, so it exercises every branch.
    const glm = MODEL_PROFILES["glm-5.2"];
    const m3 = MODEL_PROFILES["minimax-m3"];

    test("passes a supported non-default level through", () => {
      expect(glm && effectiveReasoningLevel(glm, "xhigh")).toBe("xhigh");
    });

    test("drops the profile's OWN default", () => {
      // Sending it explicitly would route a budget-style profile through the
      // level→budget table instead of its hand-tuned `maxTokens`, changing the
      // wire bytes of a turn nobody asked to change.
      expect(glm && effectiveReasoningLevel(glm, "high")).toBeUndefined();
    });

    test("drops a level the model does not support", () => {
      // How a team's stored choice survives a model swap without breaking it.
      expect(glm && effectiveReasoningLevel(glm, "minimal")).toBeUndefined();
      expect(glm && effectiveReasoningLevel(glm, "garbage")).toBeUndefined();
    });

    test("drops everything for a model with no depth knob", () => {
      expect(m3 && effectiveReasoningLevel(m3, "high")).toBeUndefined();
    });

    test("unset stays unset", () => {
      expect(glm && effectiveReasoningLevel(glm, null)).toBeUndefined();
      expect(glm && effectiveReasoningLevel(glm, undefined)).toBeUndefined();
    });
  });
});

describe("orphan <think> strip — M3 leaks a dangling </think> into content", () => {
  test("no-op when no think token is present", () => {
    expect(stripOrphanThinkTags("plain answer")).toBe("plain answer");
  });

  test("removes a dangling close tag", () => {
    expect(stripOrphanThinkTags("done</think> answer")).toBe("done answer");
  });

  test("removes a tag on its own line without leaving a blank line", () => {
    expect(stripOrphanThinkTags("a\n</think>\nb")).toBe("a\nb");
  });

  test("catches a tag split across two streamed deltas", () => {
    const s = createOrphanThinkStreamStripper();
    const out = s.push("hi </thi") + s.push("nk> there") + s.flush();
    expect(out).toBe("hi  there");
  });
});
