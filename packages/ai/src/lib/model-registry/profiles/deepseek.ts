import type { ModelProfile } from "../types";

/**
 * DeepSeek — V4 Pro (the `chat-fallback`) and V4 Flash (the workhorse behind
 * `pre-extract`, `dispatch-cheap`, `compaction-summarizer`, `transform`).
 * Catalog synced from the OpenRouter models API 2026-07-26, which corrected
 * substantial price drift: V4 Pro was recorded at $1.74/$3.48 and actually
 * bills $0.435/$0.87, with cached input at $0.0036 — the cheapest cache-read
 * rate in the fleet by two orders of magnitude.
 *
 * Family facts:
 * - **Text only.** No image, video or file modality upstream, so `nativeInput`
 *   is genuinely inert here rather than conservatively off. Attachments on a
 *   DeepSeek conversation route through the `read` / `vision` tools.
 * - **The most verbose family we ship** — 37-45k output tokens per AA task at
 *   a 3.3-4.1 reasoning:answer ratio. Kept on `style: "max-tokens"` for that
 *   reason (see below).
 * - **ZDR routes via Novita** for both models (probed 2026-07-26).
 */
export const DEEPSEEK_PROFILES: Record<string, ModelProfile> = {
  "deepseek-v4-pro": {
    key: "deepseek-v4-pro",
    family: "deepseek",
    tiers: ["flagship"],
    catalog: {
      id: "deepseek/deepseek-v4-pro",
      contextLength: 1_048_576,
      maxCompletionTokens: 384_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "reasoning",
        "include_reasoning",
        "response_format",
        "structured_outputs",
      ],
      // OpenRouter now advertises a two-rung effort ladder here — it did not
      // when this profile was written, and the old note ("only xhigh→max lifts
      // it, and OpenRouter strips that, LiteLLM #27439") is obsolete as a
      // CATALOG fact. We still drive it by token budget, see below.
      reasoning: {
        mandatory: false,
        supportedEfforts: ["xhigh", "high"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.435,
        outputPerMTok: 0.87,
        cacheReadPerMTok: 0.0036,
      },
      aaSlug: "deepseek-v4-pro",
      verbosity: { outputTokensPerTask: 36_963, reasoningToAnswerRatio: 4.1 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      // Deliberately `max-tokens` even though the catalog now lists an effort
      // ladder: DeepSeek V4 spends 4 reasoning tokens per answer token, and
      // `effort: "high"` (its upstream default) comes with no ceiling at all.
      // A budget keeps the `chat-fallback` role bounded, and it still responds
      // to the C7 toggle — the level selects the budget from the shared table
      // rather than an effort string. Switch to `effort` only with gate
      // evidence that the unbounded version is worth it.
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      enabled: true,
      // Load-bearing: bound as `chat-fallback`. Kept `passed` from its original
      // grandfathered promotion.
      evalGate: { status: "passed" },
    },
  },
  "deepseek-v4-flash": {
    key: "deepseek-v4-flash",
    family: "deepseek",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "deepseek/deepseek-v4-flash",
      contextLength: 1_048_576,
      maxCompletionTokens: 393_216,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "reasoning",
        "include_reasoning",
        "response_format",
        "structured_outputs",
      ],
      reasoning: {
        mandatory: false,
        supportedEfforts: ["xhigh", "high"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.14,
        outputPerMTok: 0.28,
        cacheReadPerMTok: 0.028,
      },
      aaSlug: "deepseek-v4-flash",
      // 45 277 tokens per task — the highest in the registry. Cheap per token,
      // expensive per answer.
      verbosity: { outputTokensPerTask: 45_277, reasoningToAnswerRatio: 3.32 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true, sort: "throughput" },
      enabled: true,
      evalGate: { status: "passed" },
    },
  },
};
