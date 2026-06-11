import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import { instrumentModel } from "../model-instrumentation";
import { wrapModelWithCache } from "../openrouter-cache";
import { MODEL_PROFILES, ROLE_BINDINGS } from "./profiles";
import type {
  ModelProfile,
  ModelRole,
  ReasoningLevel,
  RoleBinding,
} from "./types";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw "Missing OPENROUTER_API_KEY env";
}

/** Single OpenRouter client for the whole service. */
export const openrouter = createOpenRouter({
  apiKey,
});

/**
 * Role-level request envelopes. The chat kind derives its reasoning
 * param from the profile via `reasoningParamForProfile` (effort-first);
 * for every current binding this reproduces the historical settings
 * byte-for-byte (max-tokens style at `low` → 1 500) — non-default
 * levels stay unexercised until the C3 gate calibrates them.
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
  profile: ModelProfile,
): OpenRouterChatSettings | undefined => {
  switch (binding.settingsKind) {
    case "chat":
      return {
        provider: { require_parameters: true, zdr: true },
        reasoning: reasoningParamForProfile(profile),
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

/**
 * PROVISIONAL token budgets for `max-tokens`-style families, by effort
 * level. Only `low` (1 500 — the historical chat budget, Anthropic's
 * chat-turn guidance) is production-validated; the other rungs are
 * placeholders to be calibrated by C3 eval runs before anything
 * non-default requests them (the « deep thinking » toggle lands in C8).
 */
const MAX_TOKENS_BUDGET_BY_LEVEL: Record<
  Exclude<ReasoningLevel, "none">,
  number
> = {
  minimal: 512,
  low: 1_500,
  medium: 4_000,
  high: 8_000,
  xhigh: 16_000,
};

/**
 * Map the product's effort-first `ReasoningLevel` to the wire param the
 * model family honours: effort-style families get OpenRouter's `effort`
 * (whose union matches `ReasoningLevel` exactly); `max-tokens` families
 * get a budget from the table above. `none` (level or style) → no
 * reasoning param at all.
 */
export const reasoningParamForProfile = (
  profile: ModelProfile,
  level?: ReasoningLevel,
): OpenRouterChatSettings["reasoning"] => {
  const { style, defaultLevel } = profile.assessment.reasoning;
  const resolved = level ?? defaultLevel;
  if (style === "none" || resolved === "none") return undefined;
  if (style === "max-tokens") {
    return { enabled: true, max_tokens: MAX_TOKENS_BUDGET_BY_LEVEL[resolved] };
  }
  return { enabled: true, effort: resolved };
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
  const settings = settingsForRole(binding, profile);
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
