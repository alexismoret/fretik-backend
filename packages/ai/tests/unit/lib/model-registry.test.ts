import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import {
  createOrphanThinkStreamStripper,
  getProfileForRole,
  settingsForRole,
  stripOrphanThinkTags,
} from "../../../src/lib/model-registry/resolve";
import {
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
    vision: "google/gemini-3.1-flash-lite",
    "vision-fallback": "openai/gpt-4o-mini",
    extract: "google/gemini-3.1-flash-lite",
    "extract-fallback": "google/gemini-3.6-flash",
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

  test("native input activation matches the gated set (C5 media, C5v2 PDF)", () => {
    // C5 (2026-06-15) activated image+video on M3 only; C5v2 (2026-07-17)
    // activated native PDF on the catalog-`file` chat-capable profiles.
    // Any new activation elsewhere must come with its eval evidence, so
    // this guards accidental flips in both directions.
    const NATIVE_PDF_PROFILES = new Set([
      "claude-opus-4.8",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
      "gpt-5.5",
      "gemini-3.1-pro",
      "gemini-3.6-flash",
      "gemini-3.1-flash-lite",
      "mistral-medium-3.5",
    ]);
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      const { nativeInput } = profile.assessment;
      const mediaActive =
        nativeInput.image || nativeInput.video || nativeInput.audio;
      expect(`${key}:media:${mediaActive}`).toBe(
        `${key}:media:${key === "minimax-m3"}`,
      );
      expect(`${key}:pdf:${nativeInput.fileMimeTypes.join(",")}`).toBe(
        `${key}:pdf:${NATIVE_PDF_PROFILES.has(key) ? "application/pdf" : ""}`,
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
