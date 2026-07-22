import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
// `node:stream/web` TransformStream — the DOM global's `ReadableStream`
// iterator typings clash with the AI SDK's `pipeThrough`; this matches
// the native runtime semantics with the shape the SDK expects (see
// handlers/chatbot.ts + lib/langfuse-cost.ts for the same workaround).
import { TransformStream } from "node:stream/web";
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
/**
 * Speed-first routing with a QUALITY floor for the memory-utility judges
 * (P5 recall bench, 2026-07): the same gpt-oss-20b flipped correct↔broken
 * across OpenRouter upstreams. fp4/fp8 quantized servings are excluded (a
 * quantized 20b loses the judge's format discipline) and Fireworks is
 * ignored (empirically broken there — injected blocks on noise 6/6 —
 * while quant-listed as "unknown"). `sort: "throughput"` then picks the
 * fastest of what remains (Groq p50 ~0.5s); fallbacks stay enabled.
 */
const memoryUtilityProvider = (
  zdr: boolean | undefined,
): NonNullable<OpenRouterChatSettings["provider"]> => ({
  require_parameters: true,
  zdr,
  sort: "throughput",
  ignore: ["fireworks"],
  quantizations: ["bf16", "fp16", "unknown"],
});

export const settingsForRole = (
  binding: RoleBinding,
  profile: ModelProfile,
): OpenRouterChatSettings | undefined => {
  // `zdr` is a per-profile fact (see ModelProfile.assessment.provider):
  // true for every profile except the ones a recorded product decision
  // exempts (first-party-only providers without a ZDR flag).
  const zdr = profile.assessment.provider.zdr;
  // Per-profile upstream pin (cache stability across tool-loop turns).
  // Undefined for every profile that doesn't set it → no change to their
  // routing. `allow_fallbacks` stays default-on, so the pin is a
  // preference, never a hard constraint. See `ModelAssessment.provider.order`.
  const order = profile.assessment.provider.order;
  // Throughput-sorted routing when the profile asks for it (fast workhorses
  // doing bulk output-heavy work — e.g. deepseek-v4-flash). A per-profile
  // fact; undefined leaves OpenRouter's default (price) ordering.
  const sort = profile.assessment.provider.sort;
  switch (binding.settingsKind) {
    case "chat":
      return {
        provider: {
          require_parameters: true,
          zdr,
          ...(order ? { order: [...order] } : {}),
        },
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
        provider: memoryUtilityProvider(zdr),
        reasoning: { effort: "low" },
      };
    case "recall":
      return {
        provider: memoryUtilityProvider(zdr),
        reasoning: { effort: "medium" },
      };
    case "bare":
      // Bare roles leave the reasoning/usage envelope to the call site, but
      // must still carry their profile's PROVIDER policy — chiefly `zdr` (a
      // data-retention guarantee that must never be silently dropped), plus
      // throughput-sorted routing / an upstream pin when the profile asks for
      // them.
      //
      // Deliberately NO `require_parameters`: unlike `chat`, bare roles never
      // tool-call (extract/transform are structured-output/plain-text one-shots,
      // vision/cheap-tasks/tool-repair are single generations), so the anti-XML
      // guard the chat loop needs doesn't apply. And `require_parameters` is
      // actively harmful here — it narrows routing to providers advertising
      // EVERY request parameter, which empties the pool when a pinned model's
      // only ZDR endpoint omits one: Gemini's ZDR route (Vertex) doesn't
      // advertise `temperature`, which extract/vision send at 0, so ZDR + this
      // flag → "No endpoints found matching your data policy" on every call.
      // Same reasoning as the embeddings provider block (see `lib/embeddings.ts`).
      return {
        provider: {
          zdr,
          ...(order ? { order: [...order] } : {}),
          ...(sort ? { sort } : {}),
        },
      };
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
  const { style, defaultLevel, maxTokens } = profile.assessment.reasoning;
  const resolved = level ?? defaultLevel;
  if (style === "none" || resolved === "none") return undefined;
  if (style === "max-tokens") {
    // A per-profile `maxTokens` override (adaptive models that over-think,
    // e.g. MiniMax M3) wins over the shared level→budget table.
    return {
      enabled: true,
      max_tokens: maxTokens ?? MAX_TOKENS_BUDGET_BY_LEVEL[resolved],
    };
  }
  return { enabled: true, effort: resolved };
};

export interface ResolvedModel {
  model: LanguageModelV4;
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

const THINK_TAGS = ["<think>", "</think>"] as const;
const MAX_THINK_TAG_LEN = Math.max(...THINK_TAGS.map((t) => t.length));

/**
 * Strip standalone `<think>` / `</think>` tokens the reasoning extractor
 * leaves behind. MiniMax M3 (and other open-weights families) route
 * reasoning through OpenRouter's native `reasoning_details` channel yet
 * leak a dangling `</think>` into the CONTENT channel on continuation
 * steps — with no partner tag `extractReasoningMiddleware` keeps it, so
 * it renders as user-facing text and splits the chat tool-activity group.
 * Pure, no-op when no `think` token is present; collapses the blank line
 * a tag-on-its-own-line would leave.
 */
export const stripOrphanThinkTags = (text: string): string => {
  if (!text.includes("think")) return text;
  let out = text;
  for (const tag of THINK_TAGS) {
    out = out.split(`\n${tag}\n`).join("\n");
    out = out.split(tag).join("");
  }
  return out;
};

/**
 * Longest suffix of `buffer` that is a strict prefix of a tag — held back
 * across deltas so a tag split over two chunks is still caught.
 */
const pendingThinkTagSuffixLen = (buffer: string): number => {
  const start = Math.max(0, buffer.length - (MAX_THINK_TAG_LEN - 1));
  for (let i = start; i < buffer.length; i++) {
    const tail = buffer.slice(i);
    if (THINK_TAGS.some((tag) => tag.startsWith(tail)))
      return buffer.length - i;
  }
  return 0;
};

/** Stateful stripper — a tag can span two text-deltas; buffer only the partial-tag tail. */
export const createOrphanThinkStreamStripper = () => {
  let buffer = "";
  return {
    push: (delta: string): string => {
      buffer += delta;
      const hold = pendingThinkTagSuffixLen(buffer);
      const emittable = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(buffer.length - hold);
      return stripOrphanThinkTags(emittable);
    },
    flush: (): string => {
      const rest = stripOrphanThinkTags(buffer);
      buffer = "";
      return rest;
    },
  };
};

/**
 * Output-only middleware that removes orphan `think` tags from both the
 * streaming and non-streaming text paths. MUST sit OUTSIDE
 * `reasoningTagMiddleware` (first in the wrap array) so the extractor
 * sees the raw output first and pulls paired `<think>…</think>` into
 * reasoning before we clean whatever dangling tag remains.
 */
const orphanTagMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const content = result.content.map((part): LanguageModelV4Content =>
      part.type === "text"
        ? { ...part, text: stripOrphanThinkTags(part.text) }
        : part,
    );
    return { ...result, content };
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const strippers = new Map<
      string,
      ReturnType<typeof createOrphanThinkStreamStripper>
    >();
    const cleaned = stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            if (part.type === "text-delta") {
              let stripper = strippers.get(part.id);
              if (!stripper) {
                stripper = createOrphanThinkStreamStripper();
                strippers.set(part.id, stripper);
              }
              const delta = stripper.push(part.delta);
              if (delta) controller.enqueue({ ...part, delta });
              return;
            }
            if (part.type === "text-end") {
              const stripper = strippers.get(part.id);
              if (stripper) {
                const delta = stripper.flush();
                strippers.delete(part.id);
                if (delta) {
                  controller.enqueue({
                    type: "text-delta",
                    id: part.id,
                    delta,
                  });
                }
              }
              controller.enqueue(part);
              return;
            }
            controller.enqueue(part);
          },
          flush: (controller) => {
            for (const [id, stripper] of strippers) {
              const delta = stripper.flush();
              if (delta) controller.enqueue({ type: "text-delta", id, delta });
            }
            strippers.clear();
          },
        },
      ),
    );
    return { stream: cleaned, ...rest };
  },
};

const buildResolved = (binding: RoleBinding): ResolvedModel => {
  const profile = getProfile(binding.profileKey);
  const settings = settingsForRole(binding, profile);
  const raw = settings
    ? openrouter.chat(profile.catalog.id, settings)
    : openrouter.chat(profile.catalog.id);
  const cleaned =
    binding.settingsKind === "chat"
      ? wrapLanguageModel({
          model: raw,
          // Order matters: extractReasoning innermost (sees raw output
          // first, pulls paired <think>…</think> into reasoning), orphan
          // strip outermost (cleans the leftover dangling tag).
          middleware: [orphanTagMiddleware, reasoningTagMiddleware],
        })
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
  // Tracks the team's flagship pick by default (same as chat), overridable
  // per-workflow via `modelProfileKey`.
  workflow: "flagship",
  "dispatch-cheap": "workhorse",
  "pre-extract": "workhorse",
  "pre-extract-fallback": "fixed",
  // FIXED since P5-bis (2026-07): the recall judge is a SYSTEM quality
  // component — the eval suite showed gpt-oss-20b unstable on it at every
  // effort level, so a team's utility pick must not silently degrade the
  // memory of every turn. Code default only (gpt-oss-120b).
  "active-memory": "fixed",
  "memory-extract": "utility",
  "memory-distill": "utility",
  // FIXED (P8.2): the consolidation judge is a system quality component (like
  // the recall judge) — a team's utility pick must not degrade it below the
  // 120b that makes temporal re-anchoring reliable.
  "memory-consolidate": "fixed",
  "compaction-summarizer": "workhorse",
  "cheap-tasks": "utility",
  // FIXED: repair is a SYSTEM reliability component on the hot path of every
  // malformed tool call — a team's pick must not slow it below the 120b.
  "tool-repair": "fixed",
  vision: "fixed",
  "vision-fallback": "fixed",
  extract: "fixed",
  "extract-fallback": "fixed",
  // Tracks the team's workhorse pick: bulk prose transformation is a
  // cost/quality preference a team may legitimately tune, and the fixed
  // fallback catches a weak pick's truncations/refusals.
  transform: "workhorse",
  "transform-fallback": "fixed",
};

/** Representative role whose code-default profile is the tier's recommendation. */
const TIER_DEFAULT_ROLE: Record<ModelTier, ModelRole> = {
  flagship: "chat",
  workhorse: "pre-extract",
  utility: "cheap-tasks",
};

/**
 * A profile a team may pick for a tier: it is `enabled` (product on/off) and
 * LISTS that tier. A multi-tier profile (e.g. Sonnet 4.6 — flagship +
 * workhorse) is selectable in each tier it lists. `enabled:false` hides a model
 * everywhere (cost / beta), and removing a tier from `tiers` is the per-tier
 * off-switch (e.g. a model offered in workhorse but not flagship).
 *
 * The eval gate validates the FLAGSHIP (chat) envelope only, so **only
 * flagship requires `passed`** — workhorse / utility are lower-stakes auxiliary
 * roles (titles, memory, pre-extract, compaction) a team can pick without a
 * gate run. This is what lets a model serve workhorse/utility before (or
 * without ever) being gated as a flagship.
 */
export const isSelectableForTier = (
  profile: ModelProfile,
  tier: ModelTier,
): boolean =>
  profile.assessment.enabled !== false &&
  profile.tiers.includes(tier) &&
  (tier !== "flagship" || profile.assessment.evalGate.status === "passed");

/** Every gate-passed profile recommended for a tier (the tier's picker menu). */
export const listSelectableProfilesForTier = (
  tier: ModelTier,
): readonly ModelProfile[] =>
  listProfiles().filter((profile) => isSelectableForTier(profile, tier));

/** The code-default profile key for a tier — badged "recommended" in the UI. */
export const recommendedProfileKeyForTier = (tier: ModelTier): string =>
  ROLE_BINDINGS[TIER_DEFAULT_ROLE[tier]].profileKey;

/**
 * Resolve a STORED per-tier pick to an effective profile key, with graceful
 * degradation: an unset, unknown, or no-longer-selectable (removed /
 * gate-failed / wrong-tier) key falls back to the tier's code default.
 * Returns the effective key plus whether a fallback occurred, so a caller can
 * surface a one-line UI notice. Used by both the conversation flagship pin and
 * the C8b per-team workhorse / utility resolution.
 *
 * Distinct from `resolveChatModelForProfile`, which deliberately skips the
 * gate check (the eval harness must run `pending` candidates). User-facing
 * tier picks MUST be gate-passed — hence the `isSelectableForTier` check.
 */
export const resolveTierProfileKey = (
  tier: ModelTier,
  storedKey: string | null | undefined,
): { profileKey: string; fellBack: boolean } => {
  const fallback = recommendedProfileKeyForTier(tier);
  if (!storedKey) return { profileKey: fallback, fellBack: false };
  const profile = MODEL_PROFILES[storedKey];
  if (profile && isSelectableForTier(profile, tier)) {
    return { profileKey: storedKey, fellBack: false };
  }
  return { profileKey: fallback, fellBack: true };
};

/**
 * Resolve a conversation's pinned flagship key for the chat loop — the
 * flagship-tier specialisation of `resolveTierProfileKey`.
 */
export const resolveFlagshipProfileKey = (
  pinnedKey: string | null | undefined,
): { profileKey: string; fellBack: boolean } =>
  resolveTierProfileKey("flagship", pinnedKey);

// Per-replica memo of role-profile model instances (C8b). Keyed
// `${role}:${profileKey}` — bounded by roles × registry profiles. Like
// `resolved` / `chatResolvedByProfile`, instances are stateless wrappers, so
// every replica builds identical ones and teams sharing a pick share an
// instance (the cache is keyed by the RESOLVED profile, never by team).
const roleProfileResolved = new Map<string, ResolvedModel>();

/**
 * Resolve an ARBITRARY profile under a given ROLE's envelope — the non-chat
 * twin of `resolveChatModelForProfile`. Preserves the role's own
 * `settingsKind` (`preextract` / `active-memory` / `bare`) and cache wrapping
 * by building from `{ ...ROLE_BINDINGS[role], profileKey }`, so a workhorse
 * override never silently inherits the chat reasoning envelope. The role
 * default reuses the role-memoized instance.
 *
 * Like `resolveChatModelForProfile`, does NOT check `evalGate.status` —
 * selectability enforcement belongs to the DB read (`resolveTierProfileKey`).
 */
export const resolveModelForRoleProfile = (
  role: ModelRole,
  profileKey: string,
): ResolvedModel => {
  if (profileKey === ROLE_BINDINGS[role].profileKey) {
    return resolveModel(role);
  }
  const cacheKey = `${role}:${profileKey}`;
  const cached = roleProfileResolved.get(cacheKey);
  if (cached) return cached;
  const entry = buildResolved({ ...ROLE_BINDINGS[role], profileKey });
  roleProfileResolved.set(cacheKey, entry);
  return entry;
};
