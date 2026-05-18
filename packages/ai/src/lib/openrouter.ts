import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import { wrapModelWithCache } from "./openrouter-cache";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw "Missing OPENROUTER_API_KEY env";
}

const chatModelId = process.env.OPENROUTER_CHAT_MODEL;
if (!chatModelId) {
  throw "Missing OPENROUTER_CHAT_MODEL env";
}

const fallbackChatModelId = process.env.OPENROUTER_FALLBACK_MODEL;
if (!fallbackChatModelId) {
  throw "Missing OPENROUTER_FALLBACK_MODEL env";
}

const preextractModelId = process.env.OPENROUTER_PREEXTRACT_MODEL;
if (!preextractModelId) {
  throw "Missing OPENROUTER_PREEXTRACT_MODEL env";
}

const preextractFallbackModelId =
  process.env.OPENROUTER_PREEXTRACT_FALLBACK_MODEL;
if (!preextractFallbackModelId) {
  throw "Missing OPENROUTER_PREEXTRACT_FALLBACK_MODEL env";
}

export const openrouter = createOpenRouter({
  apiKey,
});

/**
 * Parse `CHATBOT_REASONING_MAX_TOKENS` from env with a 1 500 default.
 * The default tracks Anthropic's published guidance for chat-style turns
 * (Opus 4.7 best-practices: "When in doubt, respond directly … extended
 * thinking should only be used when it will meaningfully improve answer
 * quality"). For long-horizon coding or research workloads, raise via env
 * — the knob exists precisely because no single number serves every task.
 *
 * We keep parsing off the hot path (called once at module init) so a
 * malformed env value fails loudly at boot instead of silently dropping
 * back to the default mid-request.
 */
const parseChatbotReasoningMaxTokens = (): number => {
  const raw = process.env.CHATBOT_REASONING_MAX_TOKENS;
  if (raw === undefined || raw === "") return 1_500;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid CHATBOT_REASONING_MAX_TOKENS: "${raw}" — expected a positive integer.`,
    );
  }
  return parsed;
};

/**
 * OpenRouter per-model settings applied to every chat model we use.
 *
 * `provider.require_parameters: true` is LOAD-BEARING for tool-calling:
 * by default, OpenRouter silently drops unsupported parameters (including
 * `tools`) when routing to an upstream provider that does not implement
 * them. When that happens, models like MiniMax M2.7 see NO native tool
 * schemas in their request and fall back to their training-time XML
 * format for tool calls — which then leaks as plain text through the
 * streaming API and breaks our Progressive Disclosure loop.
 *
 * With `require_parameters: true`, OpenRouter ONLY routes the request
 * to upstream providers that fully support every parameter we sent
 * (tools included). If no such provider exists for the model, the
 * request fails loudly — caught by `streamChatbotWithFallback` in
 * `handlers/chatbot.ts` which retries on `fallbackChatModel`.
 *
 * @see https://openrouter.ai/docs/features/provider-routing#require-parameters
 */
const chatModelSettings: OpenRouterChatSettings = {
  provider: {
    require_parameters: true,
    /**
     * Zero Data Retention. OpenRouter ne route qu'aux providers qui ont
     * signé le ZDR addendum — exclut automatiquement les providers
     * non-compliant (ex : DeepSeek first-party CN), sans avoir à
     * maintenir une `provider.order` allowlist manuelle. Les nouveaux
     * providers ZDR sont supportés sans intervention.
     *
     * @see https://openrouter.ai/docs/features/provider-routing#zero-data-retention
     */
    zdr: true,
  },
  /**
   * Reasoning budget. OpenRouter privilégie la convention `effort`
   * (xhigh|high|medium|low) selon le provider ; `max_tokens` est
   * intermittently honoré selon le provider upstream. Le défaut 1 500
   * tracks Anthropic's chat-turn guidance ("When in doubt, respond
   * directly") et évite les runaways de reasoning observées sur les
   * questions courtes.
   *
   * **Tunable via `CHATBOT_REASONING_MAX_TOKENS`** — monter pour les
   * tâches long-horizon (extraction multi-doc, analyses complexes),
   * baisser pour latence-sensible. Les évals A/B sur le harness
   * peuvent faire varier ce knob librement.
   *
   * @see https://openrouter.ai/docs/use-cases/reasoning-tokens
   */
  reasoning: {
    enabled: true,
    max_tokens: parseChatbotReasoningMaxTokens(),
  },
  // NOTE on `parallelToolCalls`: tested 2026-05-07. Setting it to true
  // combined with `require_parameters: true` empties the eligible
  // provider pool for MiniMax M2.7 on OpenRouter — every request
  // returns 200 OK with `text: ""` + `toolCalls: []` + `finishReason:
  // undefined` (no provider routes that support both params at once).
  // Removing `require_parameters` to make room is unsafe: it lets
  // providers silently drop `tools` and the model emits XML-looking
  // plaintext through SSE. So we leave parallel-tool-calls
  // unconfigured and accept the model's default behaviour. Latency on
  // the `parallel-tool-calls` eval suite still drops ~25 % thanks to
  // the system-prompt parallelism block and the "commit to an
  // approach" rule (faster reasoning between sequential calls), even
  // though the calls themselves don't overlap on MiniMax. Re-evaluate
  // when we ship a Claude / GPT-5 route.
};

/** Primary chat model — Deepseek V4 Pro via OpenRouter (configurable via `OPENROUTER_CHAT_MODEL`). */
export const chatModel = wrapModelWithCache(
  openrouter.chat(chatModelId, chatModelSettings),
);

/**
 * Fallback model used when the primary errors out. Wrapped at the SDK level
 * in `agents/shared/agent-builder.ts`.
 */
export const fallbackChatModel = wrapModelWithCache(
  openrouter.chat(fallbackChatModelId, chatModelSettings),
);

/**
 * Settings for pre-extraction models (primary + fallback).
 *
 * Shared by both `deepseek/deepseek-v4-flash` (primary, since 2026-05-16)
 * and `openai/gpt-oss-120b` (fallback) — both expose reasoning +
 * structured output reliably on OpenRouter. The roles were swapped
 * after observing `gpt-oss-120b` timing out or emitting unparseable
 * bodies on the `/internal/field-definitions/suggest` schema; DeepSeek
 * V4 Flash is faster, cleaner, and only marginally pricier.
 *
 * `provider.require_parameters: true` forces OpenRouter to only route to
 * providers that support every param we send (including `response_format`
 * + `reasoning`) — otherwise a provider might silently drop the params
 * and we'd get un-reasoned output with no indication.
 */
const preextractModelSettings: OpenRouterChatSettings = {
  reasoning: {
    effort: "minimal",
  },
  provider: {
    require_parameters: true,
    zdr: true,
    sort: "throughput",
  },
};

/**
 * Primary pre-extraction model — `deepseek/deepseek-v4-flash` by default.
 * Consumed by `services/pre-extract/extract.ts` and
 * `handlers/field-definitions.ts` via `generateText()`.
 */
export const preextractModel = wrapModelWithCache(
  openrouter.chat(preextractModelId, preextractModelSettings),
);

/**
 * Fallback pre-extraction model — `openai/gpt-oss-120b` by default.
 * Used when the primary errors out (network, 5xx, schema validation failure).
 * Shares the primary settings (reasoning + require_parameters).
 */
export const preextractFallbackModel = wrapModelWithCache(
  openrouter.chat(preextractFallbackModelId, preextractModelSettings),
);

/** Exposed for log/diagnostic purposes. */
export const PREEXTRACT_MODEL_IDS = {
  primary: preextractModelId,
  fallback: preextractFallbackModelId,
} as const;

/**
 * Active Memory recall model. Runs the pre-reply judgment step that
 * decides which persistent memories are relevant for the current
 * turn. The task is judgment-on-context (no factual recall, no tool
 * chaining, just "is this candidate memory relevant to the user's
 * intent?"), so a small, fast, cheap model is sufficient.
 *
 * Default `openai/gpt-oss-20b`: ~$0.03 / $0.14 per MTok, ~235 tok/s
 * (Artificial Analysis), BFCL ~67%. Hallucination rate is high on
 * factual recall (SimpleQA 0.91) but irrelevant here — the model
 * works strictly on the candidate text we provide.
 *
 * Override via `OPENROUTER_ACTIVE_MEMORY_MODEL` to A/B alternatives
 * (DeepSeek V4 Flash, Haiku 4.5) if recall quality regresses.
 *
 * Reasoning intentionally OFF: judgment-on-context doesn't benefit
 * from extended thinking, and adds latency/cost.
 */
const activeMemoryModelId =
  process.env.OPENROUTER_ACTIVE_MEMORY_MODEL ?? "openai/gpt-oss-20b";

const activeMemoryModelSettings: OpenRouterChatSettings = {
  provider: {
    require_parameters: true,
    zdr: true,
  },
  /**
   * Cap reasoning to `low` rather than disabling outright. The
   * recall judge is "compare the user message + attached files +
   * recent tail against N candidate memories, decide which (if
   * any) are relevant, distil into 1-3 bullets". A bit of
   * reasoning helps when candidates are semantically close
   * (same client across two policies, e.g.) — but on a reasoning
   * model like `gpt-oss-20b`, the OpenRouter default budget can
   * blow the 15 s timeout (observed: a 17 773-token completion
   * timed out at 8 s on multi-query reformulation, same model).
   * `effort: "low"` keeps the judgment sharp without runaway
   * reasoning. Disable entirely if recall quality regresses on
   * fully-formatting tasks.
   */
  reasoning: { effort: "low" },
};

export const activeMemoryModel = openrouter.chat(
  activeMemoryModelId,
  activeMemoryModelSettings,
);

export const ACTIVE_MEMORY_MODEL_ID = activeMemoryModelId;

/**
 * Sub-agent "cheap" model used by the `dispatchAgent` tool when the
 * caller picks `model: "cheap"`. The default `deepseek/deepseek-v4-flash`
 * is the May 2026 sweet spot for tool-strong sub-agents at a low
 * price point: SWE-Bench Verified ~80%, native tool calling, 1M
 * context, reasoning toggle, ~7× cheaper than Haiku 4.5.
 *
 * Override via `OPENROUTER_DISPATCH_AGENT_CHEAP_MODEL` to A/B
 * alternatives. The "primary" path of `dispatchAgent` reuses
 * `chatModel` directly (same model as the main agent) — no separate
 * env needed for that branch.
 *
 * `chatModelSettings` is reused on purpose: a sub-agent that runs
 * the chatbot tool loop needs the same `provider.require_parameters`
 * + `reasoning` envelope to behave consistently with the parent.
 */
const dispatchAgentCheapModelId =
  process.env.OPENROUTER_DISPATCH_AGENT_CHEAP_MODEL ??
  "deepseek/deepseek-v4-flash";

export const dispatchAgentCheapModel = wrapModelWithCache(
  openrouter.chat(dispatchAgentCheapModelId, chatModelSettings),
);

export const DISPATCH_AGENT_CHEAP_MODEL_ID = dispatchAgentCheapModelId;
