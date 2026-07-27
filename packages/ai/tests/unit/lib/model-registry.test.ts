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

describe("settingsForRole — parity with historical settings objects", () => {
  test("chat-fallback and dispatch-cheap keep the historical chat envelope", () => {
    const historicalChatEnvelope = {
      provider: { require_parameters: true, zdr: true },
      reasoning: { enabled: true, max_tokens: 1_500 },
      usage: { include: true },
    };
    expect(
      settingsForRole(
        ROLE_BINDINGS["chat-fallback"],
        getProfileForRole("chat-fallback"),
      ),
    ).toEqual(historicalChatEnvelope);
    expect(
      settingsForRole(
        ROLE_BINDINGS["dispatch-cheap"],
        getProfileForRole("dispatch-cheap"),
      ),
    ).toEqual(historicalChatEnvelope);
  });

  test("preextract envelope matches the legacy preextractModelSettings", () => {
    const expected = {
      reasoning: { effort: "minimal" },
      provider: { require_parameters: true, zdr: true, sort: "throughput" },
    };
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract"],
        getProfileForRole("pre-extract"),
      ),
    ).toEqual(expected);
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract-fallback"],
        getProfileForRole("pre-extract-fallback"),
      ),
    ).toEqual(expected);
  });

  test("active-memory envelope = the P5-bis recall envelope (throughput sort + quality floor)", () => {
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
      },
      reasoning: { effort: "medium" },
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
    // A throughput-sorted profile (deepseek-v4-flash) surfaces `sort`.
    expect(
      settingsForRole(
        ROLE_BINDINGS["compaction-summarizer"],
        getProfileForRole("compaction-summarizer"),
      ),
    ).toEqual({
      provider: { zdr: true, sort: "throughput" },
    });
  });

  test("chat pins the leak-free M3 upstreams and hard-excludes Novita", () => {
    // Novita mis-splits the `</think>` boundary in streaming (first chunk of
    // the answer lands on the reasoning channel), so a fallback must never be
    // able to reach it — `order` alone is only a preference. See the rationale
    // on the minimax-m3 profile.
    const chat = settingsForRole(ROLE_BINDINGS.chat, getProfileForRole("chat"));
    expect(chat?.provider).toEqual({
      require_parameters: true,
      zdr: true,
      order: ["DeepInfra", "Parasail", "AtlasCloud"],
      ignore: ["Novita"],
    });
  });

  test("transform runs ZDR + throughput-sorted (deepseek-v4-flash policy)", () => {
    expect(
      settingsForRole(ROLE_BINDINGS.transform, getProfileForRole("transform")),
    ).toEqual({
      provider: { zdr: true, sort: "throughput" },
    });
  });
});

describe("role bindings — default model ids pinned (chat: gated M3 flip)", () => {
  const expectedIds: Record<ModelRole, string> = {
    chat: "minimax/minimax-m3",
    "chat-fallback": "deepseek/deepseek-v4-pro",
    // Workflow executor defaults to the chat profile (reliability first).
    workflow: "minimax/minimax-m3",
    "dispatch-cheap": "deepseek/deepseek-v4-flash",
    "pre-extract": "deepseek/deepseek-v4-flash",
    "pre-extract-fallback": "openai/gpt-oss-120b",
    // P5-bis (2026-07): 120b @ medium = 16/16 recall evals; 20b unstable.
    "active-memory": "openai/gpt-oss-120b",
    "memory-extract": "openai/gpt-oss-20b",
    "memory-distill": "openai/gpt-oss-20b",
    "compaction-summarizer": "deepseek/deepseek-v4-flash",
    "cheap-tasks": "openai/gpt-oss-20b",
    // ONE file-capable model backs both the `vision` tool and the `extract`
    // engine (no separate extraction role) — 3.5-flash-lite since 2026-07-25
    // (5×/3× cheaper, 12/12 full-recall free-form replays), cheap 3.1-lite
    // fallback. See ROLE_BINDINGS.vision.
    vision: "google/gemini-3.5-flash-lite",
    "vision-fallback": "google/gemini-3.1-flash-lite",
    transform: "deepseek/deepseek-v4-flash",
    "transform-fallback": "google/gemini-3.6-flash",
    "tool-repair": "openai/gpt-oss-120b",
    "memory-consolidate": "openai/gpt-oss-120b",
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
    ];
    for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
      expect(binding.wrapCache).toBe(wrapped.includes(role as ModelRole));
    }
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
