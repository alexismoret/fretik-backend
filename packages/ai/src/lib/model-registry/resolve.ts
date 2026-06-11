import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import { instrumentModel } from "../model-instrumentation";
import { wrapModelWithCache } from "../openrouter-cache";
import { MODEL_PROFILES, ROLE_BINDINGS } from "./profiles";
import type { ModelProfile, ModelRole, RoleBinding } from "./types";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw "Missing OPENROUTER_API_KEY env";
}

/** Single OpenRouter client for the whole service. */
export const openrouter = createOpenRouter({
  apiKey,
});

/**
 * Role-level request envelopes, reproducing the historical per-role
 * settings objects EXACTLY — C1 is a zero-behaviour-change chantier.
 * The profile's `reasoning.defaultLevel` (effort-first vocabulary) is
 * NOT consumed here yet: the level → wire-param mapping is chantier
 * C2 work, re-baselined through the C3 eval gate before it changes
 * anything on the wire.
 *
 * - `chat` — `provider.require_parameters: true` is LOAD-BEARING for
 *   tool-calling: by default OpenRouter silently drops unsupported
 *   parameters (including `tools`) when routing to an upstream that
 *   does not implement them; the model then falls back to its
 *   training-time XML tool format, which leaks as plaintext through
 *   SSE and breaks the Progressive Disclosure loop. `zdr: true`
 *   restricts routing to Zero-Data-Retention providers. The 1 500
 *   reasoning budget tracks Anthropic's chat-turn guidance ("when in
 *   doubt, respond directly"). `usage.include` returns the REAL
 *   upstream cost in-response for Langfuse cost capture.
 * - `preextract` — minimal reasoning + throughput-sorted routing for
 *   the structured-extraction hot path.
 * - `active-memory` — `effort: "low"` keeps the recall judge sharp
 *   without runaway reasoning (observed: default budgets blow the
 *   15 s timeout on gpt-oss-20b).
 * - `bare` — no settings object: those call sites (vision, compaction
 *   summariser, cheap one-shots) own their per-call options.
 *
 * NOTE: `sort: "throughput"` is a ROLE fact (pre-extract wants the
 * fastest provider), not a model fact — do not source it from the
 * profile here or `dispatch-cheap` would silently gain it.
 */
export const settingsForRole = (
  binding: RoleBinding,
): OpenRouterChatSettings | undefined => {
  switch (binding.settingsKind) {
    case "chat":
      return {
        provider: { require_parameters: true, zdr: true },
        reasoning: { enabled: true, max_tokens: 1_500 },
        usage: { include: true },
      };
    case "preextract":
      return {
        reasoning: { effort: "minimal" },
        provider: { require_parameters: true, zdr: true, sort: "throughput" },
      };
    case "active-memory":
      return {
        provider: { require_parameters: true, zdr: true },
        reasoning: { effort: "low" },
      };
    case "bare":
      return undefined;
  }
};

export interface ResolvedModel {
  model: LanguageModelV3;
  profile: ModelProfile;
  binding: RoleBinding;
}

export const getProfile = (key: string): ModelProfile => {
  const profile = MODEL_PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown model profile key: "${key}"`);
  }
  return profile;
};

export const getProfileForRole = (role: ModelRole): ModelProfile =>
  getProfile(ROLE_BINDINGS[role].profileKey);

export const listProfiles = (): readonly ModelProfile[] =>
  Object.values(MODEL_PROFILES);

const resolved = new Map<ModelRole, ResolvedModel>();

/**
 * Resolve a role to its instrumented model instance. Memoized — one
 * instance per role for the lifetime of the process, mirroring the
 * historical module-level singletons. Per-team / per-conversation
 * profile overrides (C8) will layer on top of these code defaults.
 */
export const resolveModel = (role: ModelRole): ResolvedModel => {
  const cached = resolved.get(role);
  if (cached) return cached;

  const binding = ROLE_BINDINGS[role];
  const profile = getProfile(binding.profileKey);
  const settings = settingsForRole(binding);
  const raw = settings
    ? openrouter.chat(profile.catalog.id, settings)
    : openrouter.chat(profile.catalog.id);
  const model = instrumentModel(
    binding.wrapCache ? wrapModelWithCache(raw, profile) : raw,
  );

  const entry: ResolvedModel = { model, profile, binding };
  resolved.set(role, entry);
  return entry;
};
