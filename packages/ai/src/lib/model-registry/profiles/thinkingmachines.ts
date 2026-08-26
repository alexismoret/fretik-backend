import type { ModelProfile } from "../types";

/**
 * Thinking Machines — Inkling. New family, added 2026-07-26; catalog read from
 * the OpenRouter models API the same day.
 *
 * An open-weight (Apache 2.0) 975B/41B-active model with a 1M context and the
 * widest effort ladder in the registry: `max|high|medium|low|minimal|none`.
 * Middle-of-the-pack capability (40.7 AA intelligence, just under MiniMax M3's
 * 44.4) at 3.15× an M3 turn, so it ships disabled on cost.
 *
 * Notes:
 * - **Accepts `text,image,audio`** — no `file` and no `video`. Image is
 *   activated; audio stays off registry-wide (no call site emits audio parts).
 * - **No `response_format` / `structured_outputs`** upstream, so the
 *   `extract` engine's constrained-decoding path cannot use it.
 * - **No `maxCompletionTokens`**: OpenRouter reports null.
 * - **ZDR routes via BaseTen** (probed 2026-07-26).
 */
export const THINKING_MACHINES_PROFILES: Record<string, ModelProfile> = {
  inkling: {
    key: "inkling",
    family: "thinkingmachines",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "thinkingmachines/inkling",
      contextLength: 1_048_576,
      maxCompletionTokens: 262_144,
      inputModalities: ["text", "image", "audio"],
      outputModalities: ["text"],
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "reasoning",
        "include_reasoning",
      ],
      reasoning: {
        mandatory: false,
        supportedEfforts: ["max", "high", "medium", "low", "minimal", "none"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "standard",
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 4.05,
        cacheReadPerMTok: 0.17,
      },
      aaSlug: "inkling",
      verbosity: { outputTokensPerTask: 25_258, reasoningToAnswerRatio: 3.53 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: [],
        audio: false,
        limits: { maxImagesPerRequest: 6 },
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
};
