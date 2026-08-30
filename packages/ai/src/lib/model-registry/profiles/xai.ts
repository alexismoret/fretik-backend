import { NATIVE_FILE_MAX_BYTES, type ModelProfile } from "../types";

/**
 * xAI — Grok. New family, added 2026-07-26; catalog read from the OpenRouter
 * models API the same day.
 *
 * Grok 4.5 is the second-most capable model in the registry (53.8 AA
 * intelligence, 45.7 agentic) and unusually fast for its class — 10.3s to first
 * answer token, where Claude Sonnet 5 takes 192s and Kimi-class models minutes.
 * It is disabled purely on cost: 5.61× a MiniMax M3 turn, driven by a $0.30
 * cached-input rate that is 5× MiniMax's.
 *
 * Notes:
 * - **Reasoning is mandatory** and the ladder stops at `high` — no `xhigh`, no
 *   `none`. Never send either.
 * - **No `maxCompletionTokens`**: OpenRouter reports null for this model, so
 *   the field is omitted rather than guessed.
 * - **ZDR routes via xAI first-party** (probed 2026-07-26).
 */
export const XAI_PROFILES: Record<string, ModelProfile> = {
  "grok-4.5": {
    key: "grok-4.5",
    family: "xai",
    catalog: {
      id: "x-ai/grok-4.5",
      contextLength: 500_000,
      maxCompletionTokens: 450_000,
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
        mandatory: true,
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.3,
      },
      aaSlug: "grok-4-5",
      verbosity: { outputTokensPerTask: 13_830, reasoningToAnswerRatio: 1.19 },
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
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
};
