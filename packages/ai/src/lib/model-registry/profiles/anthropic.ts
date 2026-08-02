import { NATIVE_FILE_MAX_BYTES, type ModelProfile } from "../types";

/**
 * Anthropic — Claude. Catalog synced from the OpenRouter models API
 * 2026-07-26.
 *
 * Family facts that hold for every profile here:
 * - **Explicit prompt caching.** Claude needs `cache_control` breakpoints, so
 *   `cache.strategy` is `explicit-breakpoints` (matched by
 *   `shouldInjectCacheControl`, `lib/openrouter-cache.ts`). Cache WRITES cost
 *   ~1.25× input, unlike the implicit-cache families.
 * - **Signed reasoning.** Never set `reasoning.replayInHistory: false` —
 *   Anthropic signs its thinking blocks and requires them echoed back
 *   alongside tool results WITHIN a turn. (Cross-turn reasoning is stripped
 *   for every profile anyway, one layer up in `prepareModelMessages`, so the
 *   constraint is specifically about the in-turn tool loop.)
 * - **ZDR routes via Amazon Bedrock** (probed 2026-07-26, all three models).
 * - **Every profile is `enabled: false` on cost.** Even Haiku 4.5, the
 *   cheapest, runs ~2.71× a MiniMax M3 turn — just over the GPT-5.6 Luna
 *   @xhigh ceiling. They stay visible in the picker with `disabledReason:
 *   "cost"`; flip `enabled` the day billing exists.
 */
export const ANTHROPIC_PROFILES: Record<string, ModelProfile> = {
  "claude-opus-5": {
    key: "claude-opus-5",
    family: "anthropic",
    tiers: ["flagship"],
    catalog: {
      id: "anthropic/claude-opus-5",
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["text", "image", "file"],
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
        supportedEfforts: ["max", "xhigh", "high", "medium", "low"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
      },
      aaSlug: "claude-opus-5",
      verbosity: { outputTokensPerTask: 36_978, reasoningToAnswerRatio: 1.94 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
  "claude-sonnet-5": {
    key: "claude-sonnet-5",
    family: "anthropic",
    tiers: ["flagship"],
    catalog: {
      id: "anthropic/claude-sonnet-5",
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["text", "image", "file"],
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
        supportedEfforts: ["max", "xhigh", "high", "medium", "low"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.2,
      },
      aaSlug: "claude-sonnet-5",
      // The most verbose model in the fleet by a wide margin — 68.7k output
      // tokens per AA task at a 4.4 reasoning:answer ratio, ~3× Luna @xhigh.
      // That verbosity, not its $2/$10 headline, is what makes it 6.95× an M3
      // turn.
      verbosity: { outputTokensPerTask: 68_736, reasoningToAnswerRatio: 4.37 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
  "claude-haiku-4.5": {
    key: "claude-haiku-4.5",
    family: "anthropic",
    tiers: ["workhorse", "utility"],
    catalog: {
      id: "anthropic/claude-haiku-4.5",
      contextLength: 200_000,
      maxCompletionTokens: 64_000,
      inputModalities: ["text", "image", "file"],
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
      // No `supportedEfforts` upstream — Haiku honours only a token budget,
      // hence `style: "max-tokens"` below and no C7 steering.
      reasoning: { mandatory: false },
    },
    assessment: {
      costClass: "standard",
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
      },
      aaSlug: "claude-4-5-haiku-reasoning",
      verbosity: { outputTokensPerTask: 23_537, reasoningToAnswerRatio: 2.97 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
};
