import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { instrumentModel } from "../model-instrumentation";
import { wrapModelWithCache } from "../openrouter-cache";
import { MODEL_PROFILES, ROLE_BINDINGS } from "./profiles";
import type {
  ModelProfile,
  ModelRole,
  ModelTier,
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
  // `zdr` is a per-profile fact (see ModelProfile.assessment.provider):
  // true for every profile except the ones a recorded product decision
  // exempts (first-party-only providers without a ZDR flag).
  const zdr = profile.assessment.provider.zdr;
  switch (binding.settingsKind) {
    case "chat":
      return {
        provider: { require_parameters: true, zdr },
        reasoning: reasoningParamForProfile(profile),
        usage: { include: true },
      };
    case "preextract":
      return {
        reasoning: { effort: "minimal" },
        provider: { require_parameters: true, zdr, sort: "throughput" },
      };
    case "active-memory":
      return {
        provider: { require_parameters: true, zdr },
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

/**
 * Pulls a `<think>…</think>` block out of the CONTENT channel back into
 * reasoning. Open-weights families (MiniMax M3, DeepSeek, …) intermittently
 * emit their reasoning inline in content on continuation turns (observed ~10%
 * of prod chat turns), which would otherwise render as raw `<think>` text in
 * the user-facing answer. No-op for models whose reasoning is natively
 * separated (Anthropic / Google / OpenAI emit no `<think>` text). Applied only
 * on the user-facing `chat` path — internal roles (pre-extract, judge) don't
 * surface text to users.
 */
const reasoningTagMiddleware = extractReasoningMiddleware({
  tagName: "think",
  separator: "\n",
});

const buildResolved = (binding: RoleBinding): ResolvedModel => {
  const profile = getProfile(binding.profileKey);
  const settings = settingsForRole(binding, profile);
  const raw = settings
    ? openrouter.chat(profile.catalog.id, settings)
    : openrouter.chat(profile.catalog.id);
  const cleaned =
    binding.settingsKind === "chat"
      ? wrapLanguageModel({ model: raw, middleware: reasoningTagMiddleware })
      : raw;
  const model = instrumentModel(
    binding.wrapCache ? wrapModelWithCache(cleaned, profile) : cleaned,
  );
  return { model, profile, binding };
};

// Per-replica memoization of STATELESS constructs (model client
// wrappers). Deterministic from code, so every replica builds
// identical instances — no cross-replica coordination needed, same
// multi-replica model as the historical module-level singletons.
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
  const entry = buildResolved(ROLE_BINDINGS[role]);
  resolved.set(role, entry);
  return entry;
};

// Bounded: getProfile throws on unknown keys, so at most one entry per
// registry profile.
const chatResolvedByProfile = new Map<string, ResolvedModel>();

/**
 * Resolve an ARBITRARY profile under the chat envelope (same settings
 * kind + cache wrapping as the `chat` role). This is the seam the C3
 * eval header (`X-Model-Profile-Key`) and the C8 per-team /
 * per-conversation selection resolve through. Memoized per profile
 * key; the default chat profile reuses the role-memoized instance.
 *
 * Deliberately does NOT check `evalGate.status`: the eval harness must
 * run PENDING candidates — that is how they get gated. Selectability
 * enforcement (only `passed` profiles) belongs to the C8 DB read.
 */
export const resolveChatModelForProfile = (
  profileKey: string,
): ResolvedModel => {
  if (profileKey === ROLE_BINDINGS.chat.profileKey) {
    return resolveModel("chat");
  }
  const cached = chatResolvedByProfile.get(profileKey);
  if (cached) return cached;
  const entry = buildResolved({
    role: "chat",
    profileKey,
    settingsKind: "chat",
    wrapCache: true,
  });
  chatResolvedByProfile.set(profileKey, entry);
  return entry;
};

// ============================================================================
// C8 — per-team / per-conversation tier selection
// ============================================================================

/**
 * The user-selectable tier each role belongs to (chantier C8). The three
 * tiers map the ~10 internal roles onto the three knobs a team customises;
 * `"fixed"` roles (fallbacks, capability-routed vision) are never
 * user-overridable in v1. This map + `isSelectableForTier` are the
 * foundation C8b reuses to make workhorse/utility resolution team-aware.
 */
export const ROLE_TIER: Record<ModelRole, ModelTier | "fixed"> = {
  chat: "flagship",
  "chat-fallback": "fixed",
  "dispatch-cheap": "workhorse",
  "pre-extract": "workhorse",
  "pre-extract-fallback": "fixed",
  "active-memory": "utility",
  "compaction-summarizer": "workhorse",
  "cheap-tasks": "utility",
  vision: "fixed",
  "vision-fallback": "fixed",
};

/** Representative role whose code-default profile is the tier's recommendation. */
const TIER_DEFAULT_ROLE: Record<ModelTier, ModelRole> = {
  flagship: "chat",
  workhorse: "pre-extract",
  utility: "cheap-tasks",
};

/**
 * A profile a team may pick for a tier: it is `enabled` (product on/off),
 * LISTS that tier, AND is gate-passed. A multi-tier profile (e.g. Sonnet 4.6
 * — flagship + workhorse) is selectable in each tier it lists. `enabled:false`
 * hides a model regardless of gate status (cost / beta); the C3 gate defines
 * the rest of the menu — `pending`/`failed` profiles never appear, so the
 * picker can never offer an unvalidated model.
 */
export const isSelectableForTier = (
  profile: ModelProfile,
  tier: ModelTier,
): boolean =>
  profile.assessment.enabled !== false &&
  profile.tiers.includes(tier) &&
  profile.assessment.evalGate.status === "passed";

/** Every gate-passed profile recommended for a tier (the tier's picker menu). */
export const listSelectableProfilesForTier = (
  tier: ModelTier,
): readonly ModelProfile[] =>
  listProfiles().filter((profile) => isSelectableForTier(profile, tier));

/** The code-default profile key for a tier — badged "recommended" in the UI. */
export const recommendedProfileKeyForTier = (tier: ModelTier): string =>
  ROLE_BINDINGS[TIER_DEFAULT_ROLE[tier]].profileKey;

/**
 * Resolve a conversation's pinned flagship key for the chat loop, with
 * graceful degradation: an unset, unknown, or no-longer-selectable
 * (removed / gate-failed / wrong-tier) pin falls back to the chat default.
 * Returns the effective key plus whether a fallback occurred, so the
 * handler can surface a one-line UI notice.
 *
 * Distinct from `resolveChatModelForProfile`, which deliberately skips the
 * gate check (the eval harness must run `pending` candidates). User-facing
 * conversation pins MUST be gate-passed flagships — hence the check here.
 */
export const resolveFlagshipProfileKey = (
  pinnedKey: string | null | undefined,
): { profileKey: string; fellBack: boolean } => {
  const fallback = ROLE_BINDINGS.chat.profileKey;
  if (!pinnedKey) return { profileKey: fallback, fellBack: false };
  const profile = MODEL_PROFILES[pinnedKey];
  if (profile && isSelectableForTier(profile, "flagship")) {
    return { profileKey: pinnedKey, fellBack: false };
  }
  return { profileKey: fallback, fellBack: true };
};
