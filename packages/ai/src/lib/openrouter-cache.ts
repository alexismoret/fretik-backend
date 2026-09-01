import {
  type LanguageModelV4,
  type LanguageModelV4Message,
  type LanguageModelV4Middleware,
  type LanguageModelV4Prompt,
  type SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

/**
 * Manual prompt-caching middleware for OpenRouter chat models.
 *
 * Some OpenRouter upstreams cache automatically (DeepSeek, OpenAI,
 * Gemini 2.5, Grok, Moonshot, Groq Kimi). Others require explicit
 * `cache_control: { type: "ephemeral" }` breakpoints on message
 * content blocks (Anthropic Claude, Alibaba Qwen).
 *
 * This middleware injects breakpoints for the explicit-caching family
 * only — letting the chat role binding (`model-registry/role-bindings.ts`)
 * swap between auto and explicit upstreams without touching agent or
 * handler code.
 *
 * # Algorithm — stable 4-breakpoint sliding cache
 *
 * Goal: maximise inter-turn hit-rate by keeping intermediate breakpoints
 * BYTE-stable across turns (same prefix hash → cache read instead of
 * fresh write). Mirrors Anthropic's automatic cache behaviour.
 *
 *   - **systemIdx**: first system message. Stable across the whole
 *     conversation.
 *   - **midAnchor**: last assistant/tool message in the FIRST 25 % of
 *     the post-system range, capped at `recentAnchor - 4`. Picked from
 *     the oldest stable region so adding new turns rarely shifts its
 *     index — the boundary `floor((n - lowBound) / 4)` moves ~½ as
 *     fast as a "first half" rule would. Skipped on short prompts
 *     (n < 8) where it cannot meaningfully bridge system and recent.
 *   - **recentAnchor**: last assistant/tool message strictly before
 *     `lastIdx`. Slides forward each turn but stays cacheable as long
 *     as the previous turn's value is within Anthropic's 20-block
 *     lookback.
 *   - **lastIdx**: last message of the prompt. Moving breakpoint —
 *     write this turn, read next turn.
 *
 * Indices that collide or fall outside valid ranges are dropped, and
 * the result is capped at 4 entries (the limit Anthropic & Qwen honour).
 *
 * # Verification
 *
 * Cache hits/writes are not instrumented here — the agent-level usage
 * logging in `agents/shared/agent-builder.ts` already reads
 * `usage.inputTokenDetails.cacheReadTokens / cacheWriteTokens`, which
 * the OpenRouter provider populates from upstream
 * `prompt_tokens_details`.
 *
 * # Known limitations
 *
 *   - TTL: 5-minute ephemeral only. Anthropic's 1-hour TTL would help on
 *     long-paused chats but doubles write cost — left for follow-up.
 *     Alibaba/Qwen does not expose a 1-hour option at all.
 *   - Cache breakpoint placement: validated 2026-05-06 on conv
 *     `019dfab7-6c69-709c-80aa-d2d99ce3ddfa`. With message-level
 *     `providerOptions.openrouter.cacheControl` (the previous code
 *     path), only the SYSTEM breakpoint registered on Qwen 3.6 Plus —
 *     `cacheRead` stayed flat at 22 565 tokens (the system prefix
 *     size) for all 28 steps while total input grew from 23K to 223K,
 *     dragging the cache ratio from 53 % to 10 %. Root cause confirmed
 *     by issue OpenRouterTeam/ai-sdk-provider#35: the Vercel AI SDK
 *     collapses non-system messages to a single string `content` when
 *     they carry only one text-part, dropping message-level
 *     `providerOptions` before the upstream sees them. The current
 *     implementation anchors `cache_control` on the LAST CONTENT-PART
 *     of every non-system targeted message, which survives the
 *     collapse and lands in the upstream request body. Re-validate
 *     after any AI SDK provider upgrade.
 *
 * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
 * @see https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
 */

const CACHE_CONTROL_VALUE = { type: "ephemeral" } as const;

/**
 * Models that REQUIRE explicit `cache_control` breakpoints. Patterns
 * are matched case-insensitively against the resolved `modelId`
 * reaching the middleware. Anything not matching is treated as
 * automatic-caching upstream and the middleware becomes a no-op.
 *
 * Verified against the live OpenRouter docs on 2026-05-06. Notable
 * absentees:
 *   - `minimax/*` — no caching is documented for the MiniMax family.
 *   - `deepseek/*` — DeepSeek caches automatically upstream.
 */
const EXPLICIT_CACHE_MODEL_PATTERNS: readonly RegExp[] = [
  /^anthropic\//i,
  /^qwen\//i,
];

/** Below this prompt length we skip the mid anchor entirely. */
const MIN_MESSAGES_FOR_MID_ANCHOR = 8;

/** Minimum spacing between mid anchor and recent anchor. */
const MID_TO_RECENT_MIN_SPACING = 4;

/** Fraction of the post-system range we search for the mid anchor. */
const MID_ANCHOR_DENOMINATOR = 4;

/**
 * Master switch. Read ONCE at module load — restart the AI service to
 * pick up a change. Defaults to `true` so swapping the chat model to
 * an explicit-caching upstream Just Works. Set to `"false"` to skip
 * the middleware entirely on auto-caching upstreams.
 */
const MANUAL_PROMPT_CACHE_ENABLED = process.env.MANUAL_PROMPT_CACHE !== "false";

/** Optional verbose logging of breakpoint placement. Read once at module load. */
const CACHE_DEBUG = process.env.AI_CACHE_DEBUG === "true";

const isStableMessage = (msg: LanguageModelV4Message | undefined): boolean =>
  msg !== undefined && (msg.role === "assistant" || msg.role === "tool");

/**
 * Find the last index in the inclusive range [start, end] whose message
 * role is `assistant` or `tool` (a "stable" anchor — content from
 * completed agentic steps that won't be rewritten).
 */
const findLastStableInRange = (
  prompt: LanguageModelV4Prompt,
  start: number,
  end: number,
): number => {
  const lo = Math.max(0, start);
  const hi = Math.min(prompt.length - 1, end);
  for (let i = hi; i >= lo; i--) {
    if (isStableMessage(prompt[i])) return i;
  }
  return -1;
};

/**
 * Pure model-id predicate — true for upstreams that require explicit
 * `cache_control` breakpoints. Env-agnostic so it's directly testable
 * without restoring `MANUAL_PROMPT_CACHE` between tests; the master
 * env switch is enforced separately in `wrapModelWithCache` below so
 * a `MANUAL_PROMPT_CACHE=false` deployment skips the middleware
 * entirely (no double-check needed on the hot path).
 */
export const shouldInjectCacheControl = (modelId: string): boolean =>
  EXPLICIT_CACHE_MODEL_PATTERNS.some((re) => re.test(modelId));

export const selectBreakpointIndices = (
  prompt: LanguageModelV4Prompt,
): readonly number[] => {
  const n = prompt.length;
  if (n === 0) return [];

  const indices: number[] = [];
  const systemIdx = prompt.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) indices.push(systemIdx);

  const lastIdx = n - 1;
  if (lastIdx <= systemIdx) return indices;

  const lowBound = systemIdx >= 0 ? systemIdx + 1 : 0;
  const recentAnchor = findLastStableInRange(prompt, lowBound, lastIdx - 1);

  let midAnchor = -1;
  if (n >= MIN_MESSAGES_FOR_MID_ANCHOR) {
    // First 25 % of the post-system range. `floor` keeps the boundary
    // stable across small turn-over-turn growth.
    const quarterEnd =
      lowBound + Math.floor((n - lowBound) / MID_ANCHOR_DENOMINATOR);
    const upperBound =
      recentAnchor >= 0
        ? Math.min(quarterEnd, recentAnchor - MID_TO_RECENT_MIN_SPACING)
        : quarterEnd;
    midAnchor = findLastStableInRange(prompt, lowBound, upperBound);
  }

  if (midAnchor >= 0) indices.push(midAnchor);
  if (recentAnchor >= 0 && recentAnchor !== midAnchor) {
    indices.push(recentAnchor);
  }
  if (lastIdx !== indices[indices.length - 1]) indices.push(lastIdx);

  return indices;
};

/**
 * Merge a `cache_control` breakpoint into existing provider options
 * without overwriting any other namespace (e.g. `reasoning_details`
 * persisted across turns lives under `openrouter.reasoningDetails`).
 *
 * Used for both message-level (system) and content-part-level
 * (everything else) breakpoints — the merge logic is identical.
 */
const withCacheControl = (
  existing: SharedV4ProviderOptions | undefined,
): SharedV4ProviderOptions => ({
  ...existing,
  openrouter: {
    ...existing?.openrouter,
    cacheControl: CACHE_CONTROL_VALUE,
  },
});

/**
 * Return a cloned prompt with `cache_control` attached at the
 * requested message indices. Existing provider options are merged,
 * never replaced. The input prompt is never mutated.
 *
 * **Placement**:
 *
 *   - **System message** (`content: string`) → attach at the
 *     **message** level via `providerOptions`. The Vercel AI SDK
 *     special-cases the system message and preserves its
 *     `providerOptions` end-to-end through the OpenRouter provider.
 *   - **All other messages** (user / assistant / tool, `content:
 *     Array<...>`) → attach on the **last content-part** of the
 *     message. The SDK collapses non-system messages to a single
 *     string `content` when there's only one text-part, which silently
 *     drops message-level `providerOptions.openrouter.cacheControl`
 *     (verified empirically on Qwen 3.6 Plus: only the system
 *     breakpoint registered, conv 019dfab7 had cacheRead frozen at
 *     22 565 tokens for all 28 steps; root cause documented in
 *     OpenRouterTeam/ai-sdk-provider#35 — *"only the system prompt
 *     caching works ... cache control remained ineffective for
 *     non-system-prompt content"*). Anchoring on a content-part
 *     ensures the cache_control marker survives the SDK's content
 *     normalisation step and lands in the upstream request body.
 *
 * The "last content-part" choice mirrors Anthropic's documented
 * behaviour: the cache breakpoint sits at the END of the cacheable
 * region, and everything BEFORE it (including the part itself) is
 * eligible for the cache. For tool-result-only messages the last
 * (and usually only) part is the tool_result; for assistant messages
 * with reasoning + text + tool_call parts, it's whichever comes last.
 */
export const applyCacheControl = (
  prompt: LanguageModelV4Prompt,
  indices: readonly number[],
): LanguageModelV4Prompt => {
  if (indices.length === 0) return prompt;
  const targets = new Set(indices);
  return prompt.map((msg, i): LanguageModelV4Message => {
    if (!targets.has(i)) return msg;
    if (msg.role === "system") {
      // System content is `string` per V3 type; attach at message level.
      return { ...msg, providerOptions: withCacheControl(msg.providerOptions) };
    }
    // user / assistant / tool — content is an array. Attach on the
    // LAST content-part so the marker survives SDK content collapsing.
    const content = msg.content;
    if (content.length === 0) return msg;
    const lastIdx = content.length - 1;
    const newContent = content.map((part, partIdx) =>
      partIdx === lastIdx
        ? { ...part, providerOptions: withCacheControl(part.providerOptions) }
        : part,
    );
    return { ...msg, content: newContent } as LanguageModelV4Message;
  });
};

const buildCacheMiddleware = (
  shouldInject: (modelId: string) => boolean,
): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  transformParams: async ({ params, model }) => {
    if (!shouldInject(model.modelId)) return params;
    const indices = selectBreakpointIndices(params.prompt);
    if (CACHE_DEBUG) {
      console.debug(
        `[openrouter-cache] model=${model.modelId} breakpoints=[${indices.join(",")}] inputMsgs=${params.prompt.length}`,
      );
    }
    if (indices.length === 0) return params;
    return { ...params, prompt: applyCacheControl(params.prompt, indices) };
  },
});

const cacheMiddleware = buildCacheMiddleware(shouldInjectCacheControl);

// Cache only — Langfuse cost capture is applied separately and uniformly
// via `instrumentModel` (`lib/model-instrumentation.ts`) so it covers every
// model, not just the cached chat ones.
//
// ONE decision path, from the model id. There used to be two: a profile-driven
// branch reading `assessment.cache.strategy` and this id-pattern table as the
// fallback for profile-less callers. They agreed on every model that ever
// reached them — the only profiles declaring `explicit-breakpoints` are the
// three Anthropic ones, whose ids all match `^anthropic/` — so the branch
// bought nothing and cost a field.
//
// The field it cost was worth losing. `cache.strategy` was answering two
// unrelated questions at once: how the vendor CHARGES (a pricing fact, now read
// off the prices by `cacheShape`) and whether the caller must place
// `cache_control` markers (a DIALECT fact, answered here). Splitting them is
// what let the charging half be derived rather than hand-written — and the
// hand-written half was wrong on 5 of 22 profiles.
export const wrapModelWithCache = (model: LanguageModelV4): LanguageModelV4 =>
  MANUAL_PROMPT_CACHE_ENABLED
    ? wrapLanguageModel({ model, middleware: [cacheMiddleware] })
    : model;
