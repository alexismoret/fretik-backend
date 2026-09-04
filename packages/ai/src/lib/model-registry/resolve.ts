import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  isTransportId,
  type LiveModelState,
  type TransportId,
} from "@fretik/shared/model-registry/types";
import {
  getLiveRegistry,
  getLiveSnapshotSync,
  getLiveStateSync,
  onLiveRegistryChange,
} from "@fretik/shared/services/model-registry/live";
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
import {
  clearSynthesisedProfileCache,
  getEffectiveProfile,
  getEffectiveProfileOrThrow,
  listEffectiveProfiles,
} from "./effective";
import {
  FUNCTION_REPRESENTATIVE,
  type ModelFunctionKey,
  selectableForFunction,
} from "./functions";
import { ROLE_BINDINGS } from "./role-bindings";
import { createTransportRegistry } from "./transports";
import type { ReasoningRequest } from "./transports/types";
import type {
  ModelProfile,
  ModelRole,
  ReasoningLevel,
  RoleBinding,
} from "./types";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("Missing OPENROUTER_API_KEY env");
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
 * quantized 20b loses the judge's format discipline). `sort: "throughput"`
 * then picks the fastest of what remains (Groq p50 ~0.5s); fallbacks stay
 * enabled.
 *
 * The Fireworks exclusion that used to be hardcoded HERE now lives on the
 * gpt-oss profiles, where it was measured. Hardcoded, it also applied to every
 * other model these roles can serve: three of them run `deepseek-v4-flash`,
 * whose vetted pool has listed Fireworks as its best endpoint since
 * 2026-08-13, so the profile named an upstream this builder then removed.
 *
 * These filters bound the pool; they do NOT make it a vetted shortlist.
 * Measured 2026-08 on gpt-oss-120b (19 endpoints): `"unknown"` alone admits
 * Amazon Bedrock, Google, DigitalOcean, Mara, Phala and Together, and Groq
 * itself is quant-listed `"unknown"` — dropping that entry would remove the
 * fastest upstream, not the unvetted ones. `only` is the instrument for a
 * shortlist, per call site (see `RECALL_JUDGE_UPSTREAMS`).
 */
const memoryUtilityProvider = (
  profile: ModelProfile,
  shortlist?: readonly string[],
): NonNullable<OpenRouterChatSettings["provider"]> => {
  const { zdr, order, ignore, only, quantizations } =
    profile.assessment.provider;
  return {
    require_parameters: true,
    zdr,
    sort: "throughput",
    ...(ignore ? { ignore: [...ignore] } : {}),
    ...(order ? { order: [...order] } : {}),
    // The floor comes from the endpoints (`quantizationsFor`), which is what
    // makes it safe to send: it is present only for models where filtering
    // leaves a host standing. The old test — exempt anything declaring `order`
    // or `only` — read as "always exempt" the moment the sync started computing
    // a pool for every model, and would have dropped the guard on the very
    // model it protects (six of gpt-oss-120b's fourteen hosts serve it at
    // fp4/fp8).
    ...(quantizations ? { quantizations: [...quantizations] } : {}),
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
 * Thinking allowance for the `page-build` role — see its `settingsForRole`
 * case for the measurement and the doctrine (role-owned, like the memory
 * budget above; never a profile-level `maxTokens`, which would take the
 * depth picker away from teams using the same model in chat).
 */
const PAGE_BUILD_REASONING_MAX_TOKENS = 8_000;

/**
 * Reasoning envelope for the memory roles. Effort-style families keep the level
 * they always had; `max-tokens` families get the tight budget above instead of
 * the level table's, which they overshoot anyway.
 */
const memoryReasoning = (
  profile: ModelProfile,
  level: ReasoningLevel,
): ReasoningWire | undefined =>
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
        ...openrouterReasoning(reasoningParamForProfile(profile)),
        usage: { include: true },
      };
    // The chat envelope with the ROLE's own thinking budget — same doctrine
    // as `MEMORY_REASONING_MAX_TOKENS`: the budget belongs to the role,
    // because the profile also serves user-facing chat, where pinning
    // `maxTokens` on the profile empties `selectableReasoningLevels` and
    // takes the depth picker away from every team that chose the model.
    //
    // Why the role wants a budget at all: reasoning is MANDATORY on the bound
    // profile (Gemini 3.7 Flash) and a Gemini thinking budget is an
    // ALLOWANCE, not just a ceiling — the model thinks to the room it is
    // given. Under the 32 000 first tried at the profile level (2026-08-23),
    // the dashboard build spent 745s of a 1 029s turn inside Gemini
    // generations: 28 calls averaging ~27s for a median answer of ~450
    // output tokens — room 70× the median answer. The zombie failure that
    // budget was bought for is covered by the delegate's fallback retry now
    // (`agents/shared/sub-agent.ts`, zombie rate 0 across the three
    // 2026-08-23 runs), so the budget's only remaining job is to bound
    // thinking TIME. 8 000 clears the build's biggest observed step (the
    // full-SFC write, ~14k total output, thinking share within budget) at a
    // quarter of the runaway allowance. Benched against the
    // `pages-final-v2-20260823` baseline (786/1029/1058s per build) — if
    // builds do not speed up, this is not the lever; say so here rather than
    // halving again.
    case "page-build":
      return {
        provider: {
          require_parameters: true,
          zdr,
          ...(order ? { order: [...order] } : {}),
          ...(ignore ? { ignore: [...ignore] } : {}),
          ...(only ? { only: [...only] } : {}),
          ...(sort ? { sort } : {}),
        },
        reasoning:
          profile.assessment.reasoning.style === "none"
            ? undefined
            : {
                enabled: true,
                max_tokens: PAGE_BUILD_REASONING_MAX_TOKENS,
              },
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
        ...openrouterReasoning(memoryReasoning(profile, "low")),
      };
    case "recall":
      return {
        provider: memoryUtilityProvider(profile, RECALL_JUDGE_UPSTREAMS),
        ...openrouterReasoning(memoryReasoning(profile, "medium")),
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
export const MAX_TOKENS_BUDGET_BY_LEVEL: Record<
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
 * The reasoning envelope in OUR vocabulary, before any transport dialect.
 *
 * It exists because `max` does not fit the provider SDK's `effort` union, which
 * stops at `xhigh` as of @openrouter/ai-sdk-provider@3.0.0 — and the response to
 * that used to be a silent clamp, `max` requests served at `xhigh`.
 *
 * That clamp was wrong twice over, both measured 2026-08-30:
 *
 *  - **The API accepts `max`.** Sent to `deepseek-v4-flash-0731`, `effort:
 *    "max"` returns 200; an invalid value is refused with the API's own list —
 *    `"max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"`, which is exactly
 *    this product's ladder. Only the SDK's TYPING was narrow, and a typing is
 *    not a capability.
 *  - **It was applied in the wrong place.** The clamp sat in the shared envelope
 *    that every transport derives from, so one SDK's union quietly removed the
 *    top rung on the gateway and on Scaleway too — neither of which has that
 *    constraint. 47 of the 396 catalogue models publish `max`, the applied
 *    `chat` default among them.
 *
 * So the level travels unclamped and `openrouterReasoning` below decides how to
 * spell it for the one transport that cannot type it.
 */
export type ReasoningWire =
  | { enabled: false; effort: "none" }
  | { enabled: true; max_tokens: number }
  | { enabled: true; effort: Exclude<ReasoningLevel, "none"> };

/**
 * Spell a reasoning envelope for the OpenRouter SDK.
 *
 * Everything the SDK's union can hold goes on `reasoning`. `max` cannot, so it
 * rides `extraBody` — the provider's own typed escape hatch (`Record<string,
 * unknown>`), merged into the request body verbatim. No cast, no lost rung.
 * Fold this back into `reasoning` when the provider widens its union.
 */
export const openrouterReasoning = (
  wire: ReasoningWire | undefined,
): Pick<OpenRouterChatSettings, "reasoning" | "extraBody"> => {
  if (wire === undefined) return { reasoning: undefined };
  if (!("effort" in wire)) return { reasoning: wire };
  const { effort } = wire;
  if (effort === "max") return { extraBody: { reasoning: wire } };
  return { reasoning: { enabled: wire.enabled, effort } };
};

/**
 * Map the product's effort-first `ReasoningLevel` to the wire param the model
 * family honours: effort-style families get an `effort` string, `max-tokens`
 * families get a budget from the table above. The level travels UNCLAMPED —
 * `openrouterReasoning` decides how to spell `max` for the one transport whose
 * SDK cannot type it.
 */
export const reasoningParamForProfile = (
  profile: ModelProfile,
  level?: ReasoningLevel,
): ReasoningWire | undefined => {
  const { style, defaultLevel } = profile.assessment.reasoning;
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
    // No ladder published, so the level travels as a budget from the shared
    // table. There used to be a per-profile override on top of it, pinned by
    // hand for models that "over-think"; it was removed with the curated
    // registry because the measurement never supported it — a live probe of
    // MiniMax M3 at three budgets returned 5 452 / 4 322 / 2 996 reasoning
    // tokens for 512 / 1 500 / 8 000 requested, i.e. no monotonicity and no
    // ceiling. The knob was never binding on the one model it was written for.
    return { enabled: true, max_tokens: MAX_TOKENS_BUDGET_BY_LEVEL[resolved] };
  }
  return { enabled: true, effort: resolved };
};

/**
 * Reduce the role's reasoning envelope to the transport-neutral request.
 *
 * Derived FROM the OpenRouter envelope rather than recomputed beside it. That
 * envelope is where every reasoning decision was measured and recorded — the
 * 1 500-token chat budget, the 256-token memory budget, the 8 000-token page
 * allowance, MiniMax's 5 000 cap — and 59 tests pin its output. Deriving means
 * a model that crosses transports carries the identical allowance; a second
 * implementation would mean two tables to keep in step, and the one that drifts
 * would drift silently.
 */
const reasoningRequestForRole = (
  binding: RoleBinding,
  profile: ModelProfile,
): ReasoningRequest | undefined => {
  const reasoning = settingsForRole(binding, profile)?.reasoning;
  if (!reasoning) return undefined;
  if (reasoning.enabled === false) return { kind: "off" };
  if ("max_tokens" in reasoning)
    return { kind: "budget", maxTokens: reasoning.max_tokens };
  if (reasoning.effort === "none") return { kind: "off" };
  return { kind: "effort", effort: reasoning.effort };
};

export interface ResolvedModel {
  model: LanguageModelV4;
  profile: ModelProfile;
  binding: RoleBinding;
  /** The transport that will serve it — recorded on traces and incidents. */
  transport: TransportId;
  /** Live row at construction time, `undefined` when the snapshot was cold. */
  live?: LiveModelState;
}

/**
 * A profile by key — curated, or synthesised from its live row.
 *
 * Both layers, because a model promoted by a WRITE has no TypeScript profile
 * and must still resolve. `effective.ts` owns the precedence (curated wins en
 * bloc) and the synthesis defaults; this stays the one door every call site
 * goes through.
 */
export const getProfile = (key: string): ModelProfile =>
  getEffectiveProfileOrThrow(key);

export const getProfileForRole = (role: ModelRole): ModelProfile =>
  getProfile(ROLE_BINDINGS[role].profileKey);

export const listProfiles = (): readonly ModelProfile[] =>
  listEffectiveProfiles();

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

/**
 * Escape hatch of last resort: force every model onto one transport, whatever
 * the database says. For the case where live state itself is the problem and
 * nobody can reach a database to fix it — a restart with one variable set beats
 * a deploy.
 */
const FORCED_TRANSPORT = ((): TransportId | undefined => {
  const raw = process.env.MODEL_TRANSPORT_FORCE;
  return raw !== undefined && isTransportId(raw) ? raw : undefined;
})();

const TRANSPORTS = createTransportRegistry(settingsForRole);

/**
 * The transport that will actually serve a profile, and the model id it uses
 * there.
 *
 * Order: the forced override, then the transport the row routes through, then
 * any other transport the row carries an id for — a model whose usual transport
 * has no adapter registered is still reachable on one that does.
 *
 * Every id comes from the ROW. There used to be a hand-written fallback map for
 * the case where the database had no opinion yet; it could not be reached (a
 * profile only exists because a row described it) and it was worse than the row
 * anyway, since the sync DISCOVERS spellings the map never had.
 */
const transportFor = (
  profileKey: string,
  live: LiveModelState | undefined,
): { transport: TransportId; modelId: string } => {
  const candidates: (TransportId | undefined)[] = [
    FORCED_TRANSPORT,
    live?.transport,
    "openrouter",
    "gateway",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const modelId = live?.modelIds[candidate];
    if (modelId !== undefined && TRANSPORTS.has(candidate))
      return { transport: candidate, modelId };
  }
  throw new Error(
    `No usable transport for profile "${profileKey}" — no model id on any implemented transport`,
  );
};

/**
 * The same resolution pinned to ONE transport, with no fallback to another.
 *
 * This is what makes "could we switch today?" answerable without switching:
 * the probe builds every role on the target transport and makes a real call,
 * while the fleet keeps routing where it routes. Falling back here would defeat
 * the purpose — a probe that quietly answers from the transport already in use
 * reports success for a migration nobody tested.
 */
const forcedTransportFor = (
  profileKey: string,
  live: LiveModelState | undefined,
  transport: TransportId,
): { transport: TransportId; modelId: string } => {
  const modelId = live?.modelIds[transport];
  if (modelId === undefined)
    throw new Error(
      `profile "${profileKey}" has no ${transport} model id — it cannot be reached there`,
    );
  if (!TRANSPORTS.has(transport))
    throw new Error(`Transport "${transport}" has no adapter registered`);
  return { transport, modelId };
};

const buildResolved = (
  binding: RoleBinding,
  forceTransport?: TransportId,
): ResolvedModel => {
  const profile = getProfile(binding.profileKey);
  const live = getLiveStateSync(binding.profileKey);
  const { transport, modelId } =
    forceTransport === undefined
      ? transportFor(binding.profileKey, live)
      : forcedTransportFor(binding.profileKey, live, forceTransport);
  const adapter = TRANSPORTS.get(transport);
  if (!adapter)
    throw new Error(`Transport "${transport}" has no adapter registered`);

  const request = {
    modelId,
    binding,
    profile,
    live,
    endpoints: live?.endpointStats ?? [],
    reasoning: reasoningRequestForRole(binding, profile),
  };
  const raw = adapter.buildModel(request);
  const cleaned =
    binding.settingsKind === "chat" || binding.settingsKind === "page-build"
      ? wrapLanguageModel({
          model: raw,
          // Order matters: extractReasoning innermost (sees raw output
          // first, pulls paired <think>…</think> into reasoning), orphan
          // strip outermost (cleans the leftover dangling tag).
          middleware: [orphanTagMiddleware, reasoningTagMiddleware],
        })
      : raw;
  // The manual breakpoint wrapper is an OpenRouter-era mechanism. On the
  // gateway the same job is done upstream by `caching: "auto"`, and doing both
  // would place two competing sets of markers on one prompt.
  const cachedForTransport =
    binding.wrapCache && transport === "openrouter"
      ? wrapModelWithCache(cleaned)
      : cleaned;
  const model = instrumentModel(
    cachedForTransport,
    { profileKey: binding.profileKey, transport },
    // Only a transport that publishes no cost of its own supplies one, and
    // only this call site knows which transport a model resolved to and what
    // rate is stored for it. The closure captures the request so the middleware
    // — which sees token counts and nothing else — can price the call.
    adapter.estimateCostUsd === undefined
      ? undefined
      : (usage) => adapter.estimateCostUsd?.(request, usage),
  );
  return { model, profile, binding, transport, live };
};

// Per-replica memoization of model client wrappers. Deterministic from code AND
// from live state, so every replica builds identical instances — but live state
// CHANGES, and a quarantine that only takes effect on the next deploy is the
// exact failure this engine exists to remove. `onLiveRegistryChange` below
// clears every map the moment any replica writes.
const resolved = new Map<ModelRole, ResolvedModel>();

/**
 * Roles that have a designated fallback MODEL — a different family on a
 * different upstream, chosen so the two cannot fail the same way.
 *
 * Read when a model reaches `lastResort`: every upstream it has, on every
 * transport, is quarantined, so it is still answering only because an empty
 * pool would be a hard outage. At that point the fallback is strictly better
 * than the model it replaces, and using it needs no new machinery — these pairs
 * already exist for mid-turn failover.
 */
/** Exported so `models:admin audit` can check a fallback still differs from its primary. */
export const ROLE_FALLBACK: Partial<Record<ModelRole, ModelRole>> = {
  chat: "chat-fallback",
  workflow: "chat-fallback",
  "dispatch-cheap": "chat-fallback",
  "pre-extract": "pre-extract-fallback",
  vision: "vision-fallback",
  transform: "transform-fallback",
};

/**
 * Resolve a role to its instrumented model instance. Memoized per role, and the
 * memo is dropped whenever live state changes anywhere in the fleet.
 *
 * A role whose model is in `lastResort` resolves to its FALLBACK role instead.
 * One hop only: if the fallback is in the same state there is nothing better to
 * reach for, and bouncing between two exhausted models would just add latency
 * to the same answer.
 */
export const resolveModel = (role: ModelRole): ResolvedModel => {
  const cached = resolved.get(role);
  if (cached) return cached;
  const fallbackRole = ROLE_FALLBACK[role];
  const binding = ROLE_BINDINGS[role];
  const degraded =
    fallbackRole !== undefined &&
    getLiveStateSync(binding.profileKey)?.lastResort === true;
  if (degraded) {
    console.warn(
      `[model-registry] ${binding.profileKey} is last-resort (every upstream quarantined) — serving role "${role}" from "${fallbackRole}" instead`,
    );
  }
  const entry = buildResolved(
    degraded && fallbackRole !== undefined
      ? { ...ROLE_BINDINGS[fallbackRole], role }
      : binding,
  );
  resolved.set(role, entry);
  return entry;
};

/**
 * Resolve a role on a NAMED transport, bypassing both the live row's choice and
 * the memo. For probes and the admin scorecard: it answers "what would this
 * role do over there", and it must not leave that instance behind in a cache
 * the fleet reads.
 *
 * Throws when the profile has no id on that transport — which is itself the
 * answer, and a better one than silently probing somewhere else.
 */
export const resolveModelOnTransport = (
  role: ModelRole,
  transport: TransportId,
): ResolvedModel => buildResolved(ROLE_BINDINGS[role], transport);

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

// Bounded the same way as `chatResolvedByProfile`.
const pageBuildResolvedByProfile = new Map<string, ResolvedModel>();

/**
 * Resolve an ARBITRARY profile under the `page-build` envelope — the seam the
 * `--page-build-candidate` A/B path resolves through. Without this twin, a
 * candidate builder resolved through the CHAT envelope and silently ran
 * without the role's reasoning allowance (`PAGE_BUILD_REASONING_MAX_TOKENS`),
 * so the A/B compared two different envelopes instead of two models.
 */
export const resolvePageBuildModelForProfile = (
  profileKey: string,
): ResolvedModel => {
  if (profileKey === ROLE_BINDINGS["page-build"].profileKey) {
    return resolveModel("page-build");
  }
  const cached = pageBuildResolvedByProfile.get(profileKey);
  if (cached) return cached;
  const entry = buildResolved({
    role: "page-build",
    profileKey,
    settingsKind: "page-build",
    wrapCache: true,
  });
  pageBuildResolvedByProfile.set(profileKey, entry);
  return entry;
};

// ============================================================================
// C8 — per-team / per-conversation tier selection
// ============================================================================

/**
 * Roles are mapped to FUNCTIONS now (`functions.ts` `ROLE_FUNCTION`), not to
 * price tiers. The map that lived here said `"fixed"` for six roles — vision,
 * the recall judge, consolidation, promotion, repair and the page builder —
 * and every one of those is a team choice today, behind a capability floor
 * rather than behind a constant. Keeping it would have left a table that
 * describes behaviour the code no longer has.
 */

/**
 * The thinking depths a USER may request for a profile — what a reasoning
 * picker offers, and the allow-list a stored level is validated against.
 *
 * The gate is the CATALOG LADDER, not the wire style: a `max-tokens` profile is
 * steered just as well by the level→budget table as an `effort` profile is by
 * the effort string. One narrowing on top: a single-rung ladder is not a choice,
 * so it yields `[]` and the picker hides rather than showing one inert option. A
 * model with NO ladder at all (MiniMax M3, Claude Haiku 4.5) lands here too —
 * which is right for M3 for an independent measured reason: the C7 probe found
 * its `reasoning_tokens` flat at ~3-5k across every effort value, and one
 * upstream ignored a token budget outright.
 *
 * Sending a rung outside the ladder is a wire error waiting to happen, and for a
 * `mandatory` reasoner (every Gemini but 3.1 Flash-Lite, plus Grok) the ladder
 * correctly omits `none` — reasoning there cannot be switched off.
 *
 * The ladder is now READ from the catalogue rather than hand-listed, which
 * turned the picker on for models it had been dead for: `deepseek-v4-flash`, the
 * applied `chat` default, was curated with no ladder at all and publishes three
 * rungs (`low`, `high`, `max`).
 */
export const selectableReasoningLevels = (
  profile: ModelProfile,
): readonly ReasoningLevel[] => {
  if (profile.assessment.reasoning.style === "none") return [];
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

// ============================================================================
// Functions — what tiers are becoming
// ============================================================================

/** The code-default profile key for a function — badged "recommended". */
export const recommendedProfileKeyForFunction = (
  fn: ModelFunctionKey,
): string => ROLE_BINDINGS[FUNCTION_REPRESENTATIVE[fn]].profileKey;

/**
 * Every profile the hub DISPLAYS for a function — all of them.
 *
 * Deliberately not filtered by eligibility, unlike the tier menus it replaces.
 * A team choosing a model wants to see the fleet and why each card is or is not
 * offerable; hiding the ineligible ones answers "why is this model missing"
 * with silence. Which of them a function ACCEPTS is answered beside the list,
 * by the function's own menu — a fact about the pair, not about the model.
 */
export const listProfilesForFunctionDisplay = (): readonly ModelProfile[] =>
  listProfiles();

/**
 * Resolve a STORED per-function pick to an effective profile key, degrading to
 * the function's code default when the key is unset, unknown, or no longer
 * usable — never erroring. A model can be retired, disabled or quarantined
 * between the moment a team picked it and the moment a turn resolves it, and
 * none of those is a reason to fail the turn.
 */
export const resolveFunctionProfileKey = (
  fn: ModelFunctionKey,
  storedKey: string | null | undefined,
): { profileKey: string; fellBack: boolean } => {
  const fallback = recommendedProfileKeyForFunction(fn);
  if (!storedKey) return { profileKey: fallback, fellBack: false };
  const profile = getEffectiveProfile(storedKey);
  if (profile && selectableForFunction(profile, fn)) {
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
  resolveFunctionProfileKey("assistant", pinnedKey);

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

/**
 * Drop every memoized model instance.
 *
 * A memo keyed only by role or profile is correct while its inputs are
 * compile-time constants. They no longer are: transport, provider pool,
 * quarantines and the last-resort flag all come from live state, so an instance
 * built before a quarantine keeps routing to the host that was just removed.
 * That is precisely the delay this engine exists to eliminate, and it would be
 * the more embarrassing version of it — the decision taken, recorded, and then
 * ignored by the process that took it.
 */
export const clearResolvedModelCache = (): void => {
  resolved.clear();
  chatResolvedByProfile.clear();
  pageBuildResolvedByProfile.clear();
  roleProfileResolved.clear();
  // Synthesised profiles are built FROM live state, so they go stale on
  // exactly the same events. Cleared here rather than through a second
  // `onLiveRegistryChange` subscription: one invalidation path is one thing to
  // keep correct, and a profile surviving the instance built from it is the
  // subtlest version of this bug.
  clearSynthesisedProfileCache();
};

/**
 * Warm live state and re-arm resolution against it. Called once at service
 * boot: without it the first turn of a fresh replica resolves against an empty
 * snapshot and memoizes that, so a quarantine written yesterday would not apply
 * until the first invalidation of the day.
 *
 * Never throws — but "does not throw" is no longer "still serves". Since the
 * curated profiles were deleted (2026-08-30) there are no code defaults left to
 * fall back to: a replica whose snapshot never filled answers `Unknown model
 * profile key` to EVERY key, on every turn, and the message blames whichever key
 * the caller named. `ensureModelRegistryWarm` is what makes that recoverable.
 */
export const warmModelRegistry = async (): Promise<void> => {
  try {
    await getLiveRegistry();
    clearResolvedModelCache();
  } catch (err: unknown) {
    console.warn(
      "[model-registry] live state unavailable at boot — serving code defaults:",
      err instanceof Error ? err.message : err,
    );
  }
};

let warming: Promise<void> | null = null;

/**
 * Warm the registry if this process has never held it — otherwise a no-op, and
 * a synchronous one on the common path.
 *
 * The snapshot is module state, and module state does not only get set at boot:
 * it gets LOST. Measured 2026-09-04 in dev — `bun --hot` re-evaluated the
 * registry modules after an edit to `role-bindings.ts`, the snapshot went back
 * to cold, and every turn afterwards answered
 * `UNKNOWN_MODEL_PROFILE: "deepseek-v4-flash"` about a row that was `published,
 * enabled, healthy` in the database. Two eval cases scored 0.125 for it. The
 * same shape reaches production by a different road: a replica that boots while
 * the database is briefly unreachable logs one warning and then 400s forever,
 * because `onLiveRegistryChange` only fires on a WRITE and nothing else retries.
 *
 * An empty map is left alone deliberately: a registry with no rows is a real
 * (if broken) state and re-reading it on every turn would hammer the database
 * for the same answer. Only "never fetched" warms.
 */
export const ensureModelRegistryWarm = async (): Promise<void> => {
  if (getLiveSnapshotSync() !== undefined) return;
  warming ??= warmModelRegistry().finally(() => {
    warming = null;
  });
  await warming;
};

// Any write, on any replica, invalidates every instance built from the old
// state. Registered at module load so no caller has to remember to.
onLiveRegistryChange(clearResolvedModelCache);
