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
 * NOTE: `preextract` hardcodes `sort: "throughput"` as a ROLE fact — that
 * hot path wants the fastest provider whatever model is bound to it. Every
 * other kind sources `sort` and `only` from the PROFILE, which is where
 * "which upstreams serve this model acceptably, and how to choose among
 * them" belongs.
 *
 * This reversed on 2026-08-05. The rule used to be that `sort` must never
 * reach the chat kind, so `dispatch-cheap` would not "silently gain it" —
 * but the effect was that the agent loop, the output-heaviest caller in the
 * service, was the ONE path that could express no routing preference at all
 * beyond a hard pin, and therefore fell back to OpenRouter's default price
 * ordering. Gaining the profile's declared sort is the correct behaviour for
 * `dispatch-cheap`, not an accident to guard against.
 */
/**
 * Speed-first routing with a QUALITY floor for the memory-utility judges
 * (P5 recall bench, 2026-07): the same gpt-oss-20b flipped correct↔broken
 * across OpenRouter upstreams. fp4/fp8 quantized servings are excluded (a
 * quantized 20b loses the judge's format discipline) and Fireworks is
 * ignored (empirically broken there — injected blocks on noise 6/6 —
 * while quant-listed as "unknown"). `sort: "throughput"` then picks the
 * fastest of what remains (Groq p50 ~0.5s); fallbacks stay enabled.
 *
 * These filters bound the pool; they do NOT make it a vetted shortlist.
 * Measured 2026-08 on gpt-oss-120b (19 endpoints): `"unknown"` alone admits
 * Amazon Bedrock, Google, DigitalOcean, Mara, Phala and Together, and Groq
 * itself is quant-listed `"unknown"` — dropping that entry would remove the
 * fastest upstream, not the unvetted ones. `only` is the instrument for a
 * shortlist, per call site (see `RECALL_JUDGE_UPSTREAMS`).
 */
/** Quantization floor for OPEN routing — see the note inside the builder. */
const QUANTIZATION_FLOOR = ["bf16", "fp16", "unknown"] as const;

const memoryUtilityProvider = (
  profile: ModelProfile,
  shortlist?: readonly string[],
): NonNullable<OpenRouterChatSettings["provider"]> => {
  const { zdr, order, ignore, only } = profile.assessment.provider;
  // A profile that governs its own serving — by pinning `order` OR by declaring
  // a vetted `only` pool — is exempt from the quantization floor; one with open
  // routing takes it. Applying the floor to everything made every other model
  // untestable here: deepseek-v4-flash is served fp4 on DeepInfra, an endpoint
  // its profile vets and prices, so the list emptied its pool outright (160/160
  // calls, "No endpoints found for the request with quantization", measured
  // 2026-08-03). Quantization was never the real criterion anyway — it stood in
  // for "this small model loses its format discipline", which is a fact about
  // gpt-oss-20b, not about fp4.
  //
  // `only` has to count here alongside `order`, or moving deepseek-v4-flash off
  // its pin and onto a vetted pool (2026-08-05) would have silently re-imposed
  // the floor and reproduced that same empty pool on all three memory roles.
  const selfGoverned = order !== undefined || only !== undefined;
  return {
    require_parameters: true,
    zdr,
    sort: "throughput",
    ignore: ignore ? ["fireworks", ...ignore] : ["fireworks"],
    ...(order ? { order: [...order] } : {}),
    ...(selfGoverned ? {} : { quantizations: [...QUANTIZATION_FLOOR] }),
    // The call-site shortlist (the recall judge's latency guard) wins over the
    // profile's own pool: it is a HARD filter chosen for a role with a 15 s
    // ceiling, and intersecting the two could empty the pool.
    ...((shortlist ?? only) ? { only: [...(shortlist ?? only ?? [])] } : {}),
  };
};

/**
 * The recall judge's upstream shortlist, on a LATENCY criterion: recall runs on
 * the hot path behind a 15 s hard timeout (`RECALL_TIMEOUT_MS`), and a call
 * that blows it loses the turn's whole memory block — silently, since recall
 * soft-fails to null.
 *
 * Measured over 200 judge calls (2026-08, gpt-oss-120b): Cerebras mean 1.0 s /
 * max 4.9 s, Groq mean 2.1 s / max 4.5 s, DeepInfra mean 4.6 s / max 9.7 s.
 * Two calls hit the timeout, and DeepInfra is the only endpoint whose spread
 * reaches it — so it is excluded despite being a clean bf16 serving.
 * `sort: "throughput"` does NOT prevent this: it orders by recently measured
 * throughput, which is not a per-request latency guarantee.
 *
 * Scoped to the `recall` settings kind (the `active-memory` role, tier `fixed`,
 * so the model under it cannot change) rather than shared with the memory
 * distillers: `only` is a HARD filter that intersects with `zdr` +
 * `require_parameters`, gpt-oss-20b has no Cerebras endpoint at all, and the
 * distillers run off the hot path where 5 s costs nothing.
 */
const RECALL_JUDGE_UPSTREAMS = ["cerebras", "groq"] as const;

/**
 * Reasoning budget for the memory roles on `max-tokens`-style models.
 *
 * The shared level table's floor (`minimal` = 512) does not bind on these
 * tasks: deepseek-v4-flash spent a median 407 reasoning tokens against a 1 500
 * budget, so every rung above 407 is the same request. Measured 2026-08-04 on
 * the memory suite: capping at 256 pulls reasoning to 236 tokens and the call
 * from $0.000121 to $0.000087 (-28 %) with `distill-record-activity` and
 * `promote-oneoff` — the two cases the model change was bought for — both still
 * 10/10.
 *
 * Deliberately NOT a per-profile `maxTokens`: that field is global to the
 * profile and deepseek-v4-flash also serves `chat` and `workflow`, where a
 * 256-token ceiling would be absurd. The budget belongs to the ROLE.
 */
const MEMORY_REASONING_MAX_TOKENS = 256;

/**
 * Reasoning envelope for the memory roles. Effort-style families keep the level
 * they always had; `max-tokens` families get the tight budget above instead of
 * the level table's, which they overshoot anyway.
 */
const memoryReasoning = (
  profile: ModelProfile,
  level: ReasoningLevel,
): OpenRouterChatSettings["reasoning"] =>
  profile.assessment.reasoning.style === "max-tokens"
    ? { enabled: true, max_tokens: MEMORY_REASONING_MAX_TOKENS }
    : reasoningParamForProfile(profile, level);

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
  // Per-profile upstream exclusions — a HARD filter, unlike `order`, so a
  // fallback can't land on an upstream we've measured as broken. See
  // `ModelAssessment.provider.ignore`.
  const ignore = profile.assessment.provider.ignore;
  // Throughput-sorted routing when the profile asks for it (fast workhorses
  // doing bulk output-heavy work — e.g. deepseek-v4-flash). A per-profile
  // fact; undefined leaves OpenRouter's default (price) ordering.
  const sort = profile.assessment.provider.sort;
  // Per-profile HARD allow-list of upstreams — the vetted pool `sort` may pick
  // from. See `ModelAssessment.provider.only`.
  const only = profile.assessment.provider.only;
  switch (binding.settingsKind) {
    case "chat":
      return {
        provider: {
          require_parameters: true,
          zdr,
          ...(order ? { order: [...order] } : {}),
          ...(ignore ? { ignore: [...ignore] } : {}),
          // `only` + `sort` were previously dropped on this kind, so the chat
          // path could express no routing preference beyond a hard pin: a
          // profile's declared `sort` reached `transform` and `compaction` but
          // never the agent loop itself, which is the output-heaviest caller of
          // the three. Forwarding them is what lets the main turn route on live
          // throughput instead of OpenRouter's default price ordering.
          ...(only ? { only: [...only] } : {}),
          ...(sort ? { sort } : {}),
        },
        reasoning: reasoningParamForProfile(profile),
        usage: { include: true },
      };
    case "preextract":
      return {
        reasoning: { effort: "minimal" },
        provider: {
          require_parameters: true,
          zdr,
          // Same omission the `chat` kind carried until 2026-08-05, and with the
          // same consequence: `pre-extract` binds to deepseek-v4-flash, so
          // dropping the profile's filters ran it on the FULL 22-endpoint ZDR
          // pool. `sort: "throughput"` then reached exactly the upstreams the
          // profile excludes on measurement — Novita and SiliconFlow (reasoning
          // runaway), Phala — because a sort only REORDERS a pool, it never
          // narrows one. (Fireworks was on that list for HTTP 429 until
          // 2026-08-13, when it re-benched clean and joined the pool.) The pool is a quality
          // decision (cache population, reasoning convergence) and belongs to
          // every role serving that profile, not just the agent loop.
          ...(ignore ? { ignore: [...ignore] } : {}),
          ...(only ? { only: [...only] } : {}),
          // Role-level, not profile-level: pre-extraction is a bulk one-shot
          // where decode dominates, whatever profile is bound.
          sort: "throughput",
        },
      };
    // Both memory kinds resolve their reasoning param THROUGH the profile,
    // exactly like `chat`. A hardcoded `{ effort }` looks equivalent and is
    // not: it is honoured only by effort-style families, so every
    // `max-tokens`-style profile (deepseek-v4-flash, MiniMax M3) silently ran
    // these roles with UNBOUNDED reasoning. That is the whole of the July
    // "deepseek times out at 13-15 s on the recall judge" result — a plumbing
    // artefact, not a capability verdict, and it made an entire model family
    // untestable on memory. `reasoningParamForProfile` sends `max_tokens` to
    // those families instead (DeepInfra honours it: a 1 500 budget measured
    // 1 512 tokens) and keeps the effort string for the rest.
    case "active-memory":
      return {
        provider: memoryUtilityProvider(profile),
        reasoning: memoryReasoning(profile, "low"),
      };
    case "recall":
      return {
        provider: memoryUtilityProvider(profile, RECALL_JUDGE_UPSTREAMS),
        reasoning: memoryReasoning(profile, "medium"),
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
          ...(ignore ? { ignore: [...ignore] } : {}),
          ...(only ? { only: [...only] } : {}),
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
  // `max` doubles xhigh rather than extending the ×2 ladder further: the rung
  // exists so a `max`-capable profile can express its top setting, not to
  // license unbounded thinking on a budget-style model. Every family that
  // genuinely wants `max` (OpenAI GPT-5.6, Anthropic Claude 5, Inkling) is
  // effort-style and never reads this table.
  max: 32_000,
};

/**
 * `max` exists in OUR vocabulary (OpenRouter's HTTP API accepts it, and
 * `catalog.reasoning.supportedEfforts` records it so drift checks and the
 * picker show a model's true ladder) but the provider SDK's `effort` union
 * stops at `xhigh` as of @openrouter/ai-sdk-provider@3.0.0. Rather than cast
 * around the type, clamp: `max` requests are served at `xhigh`, the highest
 * rung the SDK can express. Costs little — Artificial Analysis measures GPT-5.6
 * Luna at 51.2 on `max` vs 49.1 on `xhigh` — and stays type-honest. Drop the
 * clamp when the provider widens its union.
 */
const wireEffort = (
  level: Exclude<ReasoningLevel, "none">,
): "xhigh" | "high" | "medium" | "low" | "minimal" =>
  level === "max" ? "xhigh" : level;

/**
 * Map the product's effort-first `ReasoningLevel` to the wire param the
 * model family honours: effort-style families get OpenRouter's `effort`
 * (clamped by `wireEffort`); `max-tokens` families get a budget from the
 * table above.
 */
export const reasoningParamForProfile = (
  profile: ModelProfile,
  level?: ReasoningLevel,
): OpenRouterChatSettings["reasoning"] => {
  const { style, defaultLevel, maxTokens } = profile.assessment.reasoning;
  // A model with no reasoning support takes no reasoning param at all: sending
  // one narrows the pool to nothing under `require_parameters`.
  if (style === "none") return undefined;
  const resolved = level ?? defaultLevel;
  if (resolved === "none") {
    // An EXPLICIT `none` has to actually switch thinking off, and omitting the
    // parameter does NOT do that — measured on GPT-5.6 Luna 2026-07-27: no
    // param → 13 reasoning tokens (the upstream applies its own default), vs 0
    // for both `{ enabled: false }` and `{ effort: "none" }`. Now that "No
    // thinking" is a menu item a user can pick, that gap is the difference
    // between the control working and lying. Both fields are sent: the SDK's
    // union requires an `effort`, and `enabled: false` is OpenRouter's own
    // documented off-switch. Only the explicit path sends it, so a profile that
    // merely DEFAULTS to `none` keeps its byte-identical historical envelope.
    return level === undefined ? undefined : { enabled: false, effort: "none" };
  }
  if (style === "max-tokens") {
    // A per-profile `maxTokens` override (adaptive models that over-think,
    // e.g. MiniMax M3) wins over the shared level→budget table.
    return {
      enabled: true,
      max_tokens: maxTokens ?? MAX_TOKENS_BUDGET_BY_LEVEL[resolved],
    };
  }
  return { enabled: true, effort: wireEffort(resolved) };
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
  // Same tier as consolidation: an autonomous write to team-shared memory is
  // a SYSTEM quality component, not a team preference.
  "memory-promote": "fixed",
  "compaction-summarizer": "workhorse",
  "cheap-tasks": "utility",
  // FIXED: repair is a SYSTEM reliability component on the hot path of every
  // malformed tool call — a team's pick must not slow it below the 120b.
  "tool-repair": "fixed",
  // ONE file-capable model (gemini-3.5-flash-lite) backs both the `vision` tool and
  // the `extract` engine — no separate extraction role. FIXED: a team's tier
  // pick must not silently degrade document extraction quality.
  vision: "fixed",
  "vision-fallback": "fixed",
  // FIXED: the page critic is the gate on what a team ships to itself. A
  // cheaper pick would not fail loudly — it would praise, which is the one
  // outcome the review exists to prevent.
  "page-review": "fixed",
  // FIXED, and for the SAME reason as the critic above — which is exactly the
  // asymmetry that went unnoticed until 2026-08-18. The critic was pinned so a
  // cheap pick could not quietly praise; the BUILDER was left on
  // `resolveModel("chat")` at module load, so every page a team ever generated
  // was written by the code default no matter which flagship they picked. A
  // page is the one artefact a team keeps and reopens: what writes it is a
  // system quality component, not a per-team cost preference.
  "page-build": "fixed",
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
 * A profile a team may pick for a tier: it is `enabled` and LISTS that tier.
 * That is the whole rule.
 *
 * `enabled: false` blocks a model everywhere (today: cost, until billing
 * exists) and removing a tier from `tiers` is the per-tier off-switch. A
 * multi-tier profile (e.g. GPT-5.6 Luna — flagship + workhorse) is selectable
 * in each tier it lists.
 *
 * **The eval-gate clause was removed on 2026-07-26.** It used to require
 * `evalGate.status === "passed"` for the flagship tier, which had frozen the
 * flagship menu at two models while twelve profiles sat `pending`: gate runs
 * are slow and costly, the suite is not a fair enough judge to be a
 * gatekeeper, and one profile already carried a hand-written override
 * explaining the gate's verdict had been overruled. The product bet is
 * breadth — a team that finds a model weak on our tools switches model.
 * Evals now gate only the APPLIED DEFAULT (`ROLE_BINDINGS` for `chat` /
 * `workflow`), enforced in `model-registry.test.ts` rather than at runtime.
 */
export const isSelectableForTier = (
  profile: ModelProfile,
  tier: ModelTier,
): boolean => profile.assessment.enabled && profile.tiers.includes(tier);

/**
 * The thinking depths a USER may request for a profile — what a reasoning
 * picker offers, and the allow-list a stored level is validated against.
 *
 * The gate is the CATALOG LADDER, not the wire style: a `max-tokens` profile is
 * steered just as well by the level→budget table as an `effort` profile is by
 * the effort string (DeepSeek V4 is deliberately budget-driven precisely so its
 * 4:1 reasoning ratio stays bounded, and still answers to the level). Two
 * narrowings on top:
 *
 *  - a single-rung ladder is not a choice, so it yields `[]` and the picker
 *    hides rather than showing one inert option. A model with NO ladder at all
 *    (MiniMax M3, Claude Haiku 4.5) lands here too — which is right for M3 for
 *    an independent measured reason: the C7 probe found its `reasoning_tokens`
 *    flat at ~3-5k across every effort value, and one upstream ignored
 *    `reasoning.max_tokens` outright.
 *  - a profile that PINS `maxTokens` yields `[]`, because that override beats
 *    the level→budget table in `reasoningParamForProfile` — the levels would be
 *    decorative. A unit test keeps a pinned budget and a real ladder from ever
 *    coexisting silently.
 *
 * Sending a rung outside the ladder is a wire error waiting to happen, and for a
 * `mandatory` reasoner (every Gemini but 3.1 Flash-Lite, plus Grok) the ladder
 * correctly omits `none` — reasoning there cannot be switched off.
 *
 * Consequence worth knowing: on the current applied default (M3) the chat
 * reasoning picker renders disabled with an explanation. Every other selectable
 * flagship steers, so the control comes alive as soon as a team picks one.
 */
export const selectableReasoningLevels = (
  profile: ModelProfile,
): readonly ReasoningLevel[] => {
  const { style, maxTokens } = profile.assessment.reasoning;
  if (style === "none") return [];
  if (style === "max-tokens" && maxTokens !== undefined) return [];
  const efforts = profile.catalog.reasoning?.supportedEfforts ?? [];
  return efforts.length > 1 ? efforts : [];
};

/**
 * Narrow a STORED or REQUESTED level to one the profile actually accepts.
 * Returns `undefined` — meaning "use the profile default" — for an unset level,
 * a level the model does not support (a team's stored choice outliving a model
 * swap, a crafted request), and for a level that IS the profile default.
 *
 * That last case matters beyond tidiness: passing the default explicitly would
 * route a `max-tokens` profile through the level→budget table instead of its
 * hand-tuned `maxTokens` override, changing the wire bytes of a turn nobody
 * asked to change.
 */
export const effectiveReasoningLevel = (
  profile: ModelProfile,
  requested: string | null | undefined,
): ReasoningLevel | undefined => {
  if (!requested) return undefined;
  const allowed = selectableReasoningLevels(profile);
  const match = allowed.find((level) => level === requested);
  if (match === undefined) return undefined;
  return match === profile.assessment.reasoning.defaultLevel
    ? undefined
    : match;
};

/** Every selectable profile for a tier — what a team may actually choose. */
export const listSelectableProfilesForTier = (
  tier: ModelTier,
): readonly ModelProfile[] =>
  listProfiles().filter((profile) => isSelectableForTier(profile, tier));

/**
 * Every profile that LISTS a tier, selectable or not — what the picker
 * DISPLAYS. Disabled models stay visible with an explanation
 * (`assessment.disabledReason`) rather than vanishing: a team that cannot yet
 * pick Claude Opus 5 is better served by seeing it greyed out with a reason
 * than by wondering whether Fretik supports Anthropic at all.
 *
 * Callers MUST still run `isSelectableForTier` before honouring a choice —
 * this is a display list, never an authorisation list.
 */
export const listProfilesForTierDisplay = (
  tier: ModelTier,
): readonly ModelProfile[] =>
  listProfiles().filter((profile) => profile.tiers.includes(tier));

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
