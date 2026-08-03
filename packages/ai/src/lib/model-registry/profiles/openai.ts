import { NATIVE_FILE_MAX_BYTES, type ModelProfile } from "../types";

/**
 * OpenAI — GPT-5.6 (Luna / Terra / Sol), GPT-5.4 (mini / nano) and the
 * open-weight GPT-OSS pair. Catalog synced from the OpenRouter models API
 * 2026-07-26.
 *
 * Family facts:
 * - **ZDR routes via Azure, and Azure forbids `max_tokens`.** Probed
 *   2026-07-26: the chat envelope (`zdr` + `require_parameters` + `tools`,
 *   no `max_tokens`) routes to Azure fine, but adding `max_tokens` empties
 *   the pool and OpenRouter answers HTTP 404 "No endpoints found matching
 *   your data policy" — Azure advertises `max_completion_tokens` instead.
 *   Every hosted OpenAI profile therefore sets `provider.omitMaxTokens`.
 *   GPT-OSS is exempt: it is open-weight and serves ZDR from DeepInfra.
 * - **Implicit caching at 10% of input** — the best cache-read ratio in the
 *   fleet, and the reason Luna is far cheaper in a real tool loop than its
 *   $1/$6 headline suggests (a Fretik turn is ~90% cached input).
 * - **Full effort ladder including `max`.** GPT-5.6 accepts
 *   `max|xhigh|high|medium|low|none`, so these are the most steerable models
 *   we ship.
 */
export const OPENAI_PROFILES: Record<string, ModelProfile> = {
  "gpt-5.6-sol": {
    key: "gpt-5.6-sol",
    family: "openai",
    tiers: ["flagship"],
    catalog: {
      id: "openai/gpt-5.6-sol",
      contextLength: 1_050_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["file", "image", "text"],
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
        supportedEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 30,
        cacheReadPerMTok: 0.5,
      },
      aaSlug: "gpt-5-6-sol-high",
      verbosity: { outputTokensPerTask: 6_690, reasoningToAnswerRatio: 0.91 },
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
      provider: { requireParameters: true, zdr: true, omitMaxTokens: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
  "gpt-5.6-terra": {
    key: "gpt-5.6-terra",
    family: "openai",
    tiers: ["flagship"],
    catalog: {
      id: "openai/gpt-5.6-terra",
      contextLength: 1_050_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["file", "image", "text"],
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
        supportedEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.25,
      },
      aaSlug: "gpt-5-6-terra-high",
      verbosity: { outputTokensPerTask: 7_738, reasoningToAnswerRatio: 1.2 },
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
      provider: { requireParameters: true, zdr: true, omitMaxTokens: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
  "gpt-5.6-luna": {
    key: "gpt-5.6-luna",
    family: "openai",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "openai/gpt-5.6-luna",
      contextLength: 1_050_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["file", "image", "text"],
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
        supportedEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "standard",
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.1,
      },
      // Pinned to the `xhigh` AA record because that is our `defaultLevel`.
      // The spread across levels is large — 33.3 / 38.1 / 46.1 / 49.1 / 51.2
      // intelligence for low → max — so an unpinned name match would report a
      // model we don't actually run.
      aaSlug: "gpt-5-6-luna-xhigh",
      verbosity: { outputTokensPerTask: 12_492, reasoningToAnswerRatio: 2.06 },
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
      // `xhigh`, not `high`: on Fretik's turn shape (~90% cached input) the
      // bill barely moves between them — measured $27.51 vs $27.80 per 1000
      // turns, +1% — while xhigh buys +11% intelligence and +87% tau_banking
      // (tool-use reliability) over the current M3 default. The real cost of
      // xhigh is TAIL LATENCY, not money: an easy turn answers in ~3.9s, but a
      // genuinely hard constraint-satisfaction prompt measured 118s to the
      // first answer token. `max` exists upstream and scores higher still
      // (51.2 vs 49.1) — left unpinned until a gate run shows the extra tail
      // is tolerable.
      reasoning: { style: "effort", defaultLevel: "xhigh" },
      provider: { requireParameters: true, zdr: true, omitMaxTokens: true },
      enabled: true,
      // The cost ceiling every other profile is measured against: a Luna
      // @xhigh turn is 2.57× a MiniMax M3 turn, and anything dearer ships
      // `enabled: false` until billing exists.
      //
      // NOT yet the applied `chat` default. Promotion needs a gate run —
      // `bun run evals:gate -- --candidate gpt-5.6-luna` — because AA has no
      // `ifbench` / `tau2` figures for Luna, which are exactly the two axes
      // where M3 leads, and those only resolve on our own cases.
      evalGate: { status: "untested" },
    },
  },
  // GPT-5.4 Mini is deliberately NOT in the registry. It is the latest OpenAI
  // "mini", so the latest-version-only rule would admit it, but it is strictly
  // dominated: 40.0 AA intelligence at 2.04× a MiniMax M3 turn, against
  // deepseek-v4-flash at 49.9 for 0.46× — CHEAPER and 10 points smarter. The
  // 0731 swap (2026-08-02) widened this gap: the comparison used to read
  // "marginally smarter for 4.4× less money" against the April model's 40.3.
  // There is no workload where a team should pick it.
  //
  // GPT-5.4 Nano below survives the same test for a specific reason: at 0.55×
  // it is the cheapest model in the registry that can read an attachment at
  // all, and it beats gemini-3.1-flash-lite on BOTH axes (38.2 vs 25.0
  // intelligence, 0.55× vs 0.68× cost).
  "gpt-5.4-nano": {
    key: "gpt-5.4-nano",
    family: "openai",
    tiers: ["workhorse", "utility"],
    catalog: {
      id: "openai/gpt-5.4-nano",
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["file", "image", "text"],
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
        supportedEfforts: ["xhigh", "high", "medium", "low", "none"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.2,
        outputPerMTok: 1.25,
        cacheReadPerMTok: 0.02,
      },
      // AA publishes one record for this model (no per-effort variants) and no
      // throughput figures, so `speed` comes from the fallback table.
      aaSlug: "gpt-5-4-nano",
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
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true, omitMaxTokens: true },
      enabled: true,
    },
  },
  // GPT-OSS is open-weight: ZDR comes from DeepInfra, not Azure, so the
  // `omitMaxTokens` workaround above does not apply here.
  "gpt-oss-120b": {
    key: "gpt-oss-120b",
    family: "openai",
    tiers: ["workhorse"],
    catalog: {
      id: "openai/gpt-oss-120b",
      contextLength: 131_072,
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
        mandatory: true,
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "budget",
      // Median of the reachable ZDR pool (2026-08-03), not the cheapest
      // endpoint: this model has a wide provider spread and OpenRouter load-
      // balances across it. CoreWeave publishes a cached-input rate even though
      // `cache.strategy` is `none` here — recorded because the cost model reads
      // the rate directly now.
      pricing: {
        inputPerMTok: 0.085,
        outputPerMTok: 0.495,
        cacheReadPerMTok: 0.0425,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "none" },
      // The recall eval (P5-bis) runs this at `medium` through the `recall`
      // role envelope, which overrides `defaultLevel` — this value only applies
      // when a team picks it directly for a tier.
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true, sort: "throughput" },
      enabled: true,
      aaSlug: "gpt-oss-120b",
      evalGate: { status: "passed" },
    },
  },
  "gpt-oss-20b": {
    key: "gpt-oss-20b",
    family: "openai",
    tiers: ["utility"],
    catalog: {
      id: "openai/gpt-oss-20b",
      contextLength: 131_072,
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
        mandatory: true,
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "budget",
      // Pool median, same basis as gpt-oss-120b above.
      pricing: {
        inputPerMTok: 0.04,
        outputPerMTok: 0.14,
        cacheReadPerMTok: 0.03375,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "none" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      enabled: true,
      aaSlug: "gpt-oss-20b",
      evalGate: { status: "passed" },
    },
  },
};
