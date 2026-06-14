import { describe, expect, test } from "bun:test";
import {
  MODEL_PROFILES,
  ROLE_BINDINGS,
} from "../../../src/lib/model-registry/profiles";
import {
  getProfileForRole,
  settingsForRole,
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

  test("active-memory envelope matches the legacy activeMemoryModelSettings", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["active-memory"],
        getProfileForRole("active-memory"),
      ),
    ).toEqual({
      provider: { require_parameters: true, zdr: true },
      reasoning: { effort: "low" },
    });
  });

  test("bare roles get NO settings object (call sites own their options)", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["compaction-summarizer"],
        getProfileForRole("compaction-summarizer"),
      ),
    ).toBeUndefined();
    expect(
      settingsForRole(
        ROLE_BINDINGS["cheap-tasks"],
        getProfileForRole("cheap-tasks"),
      ),
    ).toBeUndefined();
    expect(
      settingsForRole(ROLE_BINDINGS.vision, getProfileForRole("vision")),
    ).toBeUndefined();
    expect(
      settingsForRole(
        ROLE_BINDINGS["vision-fallback"],
        getProfileForRole("vision-fallback"),
      ),
    ).toBeUndefined();
  });
});

describe("role bindings — default model ids pinned (chat: gated M3 flip)", () => {
  const expectedIds: Record<ModelRole, string> = {
    chat: "minimax/minimax-m3",
    "chat-fallback": "deepseek/deepseek-v4-pro",
    "dispatch-cheap": "deepseek/deepseek-v4-flash",
    "pre-extract": "deepseek/deepseek-v4-flash",
    "pre-extract-fallback": "openai/gpt-oss-120b",
    "active-memory": "openai/gpt-oss-20b",
    "compaction-summarizer": "deepseek/deepseek-v4-flash",
    "cheap-tasks": "openai/gpt-oss-20b",
    vision: "google/gemini-3.1-flash-lite",
    "vision-fallback": "openai/gpt-4o-mini",
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

  test("every family covers all three tiers", () => {
    const tiers: ModelTier[] = ["flagship", "workhorse", "utility"];
    const byFamily = new Map<string, Set<ModelTier>>();
    for (const profile of Object.values(MODEL_PROFILES)) {
      const set = byFamily.get(profile.family) ?? new Set<ModelTier>();
      set.add(profile.tier);
      byFamily.set(profile.family, set);
    }
    for (const [family, covered] of byFamily) {
      for (const tier of tiers) {
        expect(`${family}:${covered.has(tier)}`).toBe(`${family}:true`);
      }
    }
  });

  test("native file MIME types require the `file` input modality", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      if (profile.assessment.nativeFileMimeTypes.length > 0) {
        expect(profile.catalog.inputModalities).toContain("file");
      }
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
