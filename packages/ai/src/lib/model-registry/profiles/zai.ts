import type { ModelProfile } from "../types";

/**
 * Z.ai — GLM. Catalog re-synced from the OpenRouter models API 2026-08-02.
 * `maxCompletionTokens` has oscillated upstream — 131 072 on 2026-07-26,
 * 128 000 on 2026-07-30, back to 131 072 now. Re-run `bun run models:check`
 * rather than assuming this one is stable.
 * Replaces GLM-5.1 and GLM-4.7 (latest-version-only rule).
 *
 * GLM-5.2 is the most intelligent model in the fleet's affordable band (51.1 AA
 * intelligence, ahead of GPT-5.6 Luna @xhigh at 49.1) and it is genuinely
 * cheap per token. Two facts keep it from being the obvious default:
 *
 * 1. **Text only.** GLM-5.2 declares no image/video/file modality on
 *    OpenRouter, so a team picking it loses native attachment reading — every
 *    image and PDF falls back to the `vision` tool. That is a product
 *    regression relative to today's MiniMax M3 default, which reads images and
 *    video natively.
 * 2. **It is the most verbose model we ship** — 42 791 output tokens per AA
 *    task at a 6.03 reasoning:answer ratio, meaning six tokens of thinking per
 *    token of answer. That verbosity is what turns a $0.67/$2.11 headline into
 *    2.26× a MiniMax M3 turn.
 *
 * ZDR routes via Fireworks. The `</think>`-boundary streaming defect that
 * forced `ignore: ["Novita"]` on MiniMax M3 does NOT reproduce here — raw-wire
 * continuation-step probes on 2026-07-26 found 0/6 boundary leaks on every
 * GLM-5.2 upstream including Novita — so no exclusion list is needed.
 */
export const ZAI_PROFILES: Record<string, ModelProfile> = {
  "glm-5.2": {
    key: "glm-5.2",
    family: "zai",
    tiers: ["flagship"],
    catalog: {
      id: "z-ai/glm-5.2",
      contextLength: 1_048_576,
      maxCompletionTokens: 131_072,
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
      costClass: "standard",
      pricing: {
        inputPerMTok: 0.672,
        outputPerMTok: 2.112,
        cacheReadPerMTok: 0.1248,
      },
      aaSlug: "glm-5-2",
      verbosity: { outputTokensPerTask: 42_791, reasoningToAnswerRatio: 6.03 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      // `high`, never `xhigh`. Measured 2026-07-26 on a hard multi-constraint
      // prompt: `xhigh` took 818 SECONDS to emit its first answer token (16 948
      // reasoning tokens, 61 161 characters streamed). That is unusable in a
      // chat surface regardless of the intelligence it buys. `high` measures
      // 11.8s to first answer token on the same class of prompt.
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true, zdr: true },
      enabled: true,
    },
  },
};
