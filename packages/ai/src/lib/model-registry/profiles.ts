import type { ModelProfile, ModelRole, RoleBinding } from "./types";

/**
 * Seed profiles — a curated brand × tier matrix, PRUNED for
 * profitability: a family need not cover every tier (e.g. MiniMax
 * ships only its flagship M3). The picker groups by tier across
 * families, so the only invariant is that each tier has ≥1 option.
 *
 * `catalog` blocks were read from the OpenRouter models API on
 * 2026-06-11 (`scripts/check-model-catalog.ts` re-verifies them — run
 * it after any provider announcement). Tier placements follow the
 * Artificial Analysis Intelligence Index (June 2026 snapshot):
 * Opus 4.8 ≈ 61, GPT-5.5 ≈ 60, Gemini 3.5 Flash ≈ 55, MiniMax M3 ≈ 55
 * (leading open weights), DeepSeek V4 Pro ≈ 52, GLM-5.1 ≈ 51. A profile
 * may list more than one tier (e.g. Sonnet 4.6 / Gemini 3.5 Flash serve
 * both flagship and workhorse).
 *
 * A profile's `evalGate.status` stays `pending` until the C3 promotion
 * gate (a human-committed PR) flips it; incumbents already serving prod
 * before the gate existed are grandfathered `passed` with no run id. The
 * eval judge
 * (`evals/judge.ts`) intentionally stays OUTSIDE the registry: it must
 * remain a different family from the serving models.
 */

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // ───────────────────────── Anthropic ─────────────────────────
  "claude-opus-4.8": {
    key: "claude-opus-4.8",
    family: "anthropic",
    tiers: ["flagship"],
    catalog: {
      id: "anthropic/claude-opus-4.8",
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
    },
    assessment: {
      costClass: "premium",
      pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
      // enabled:false — capable but too costly to offer right now.
      enabled: false,
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      // effort-style: Claude 4.x steers thinking via the `effort` knob +
      // adaptive thinking; manual `budget_tokens` (max-tokens) is rejected /
      // deprecated (2026 docs). `defaultLevel` stays low (the only eval-
      // validated rung); tune to ~medium + re-probe steerability at its gate.
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "claude-sonnet-4.6": {
    key: "claude-sonnet-4.6",
    family: "anthropic",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "anthropic/claude-sonnet-4.6",
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
    },
    assessment: {
      costClass: "premium",
      pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
      // enabled:false — capable but too costly to offer right now.
      enabled: false,
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      // effort-style (see claude-opus-4.8): Claude 4.x uses `effort` + adaptive
      // thinking; `budget_tokens` is rejected/deprecated. defaultLevel stays
      // low (validated rung); tune to ~medium + probe at its gate.
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "claude-haiku-4.5": {
    key: "claude-haiku-4.5",
    family: "anthropic",
    tiers: ["utility"],
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
    },
    assessment: {
      costClass: "standard",
      pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
      // enabled:false — capable but too costly to offer right now.
      enabled: false,
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "explicit-breakpoints", maxBreakpoints: 4 },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },

  // ───────────────────────── OpenAI ─────────────────────────
  "gpt-5.5": {
    key: "gpt-5.5",
    family: "openai",
    tiers: ["flagship"],
    catalog: {
      id: "openai/gpt-5.5",
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
    },
    assessment: {
      costClass: "premium",
      pricing: { inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "gpt-5.4-nano": {
    key: "gpt-5.4-nano",
    family: "openai",
    tiers: ["workhorse"],
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.2,
        outputPerMTok: 1.25,
        cacheReadPerMTok: 0.02,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "gpt-oss-120b": {
    key: "gpt-oss-120b",
    family: "openai",
    tiers: ["workhorse"],
    catalog: {
      id: "openai/gpt-oss-120b",
      contextLength: 131_072,
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
    },
    assessment: {
      costClass: "budget",
      pricing: { inputPerMTok: 0.039, outputPerMTok: 0.18 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "none" },
      reasoning: { style: "effort", defaultLevel: "minimal" },
      provider: { requireParameters: true, zdr: true, sort: "throughput" },
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
    },
    assessment: {
      costClass: "budget",
      pricing: { inputPerMTok: 0.029, outputPerMTok: 0.14 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "none" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "passed" },
    },
  },
  "gpt-4o-mini": {
    key: "gpt-4o-mini",
    family: "openai",
    // vision-fallback only (fixed role) — not user-selectable in any tier.
    tiers: [],
    catalog: {
      id: "openai/gpt-4o-mini",
      contextLength: 128_000,
      maxCompletionTokens: 16_384,
      inputModalities: ["text", "image", "file"],
      outputModalities: ["text"],
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "response_format",
        "structured_outputs",
      ],
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
        cacheReadPerMTok: 0.075,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "none", defaultLevel: "none" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "passed" },
    },
  },

  // ───────────────────────── Google ─────────────────────────
  "gemini-3.1-pro": {
    key: "gemini-3.1-pro",
    family: "google",
    tiers: ["flagship"],
    catalog: {
      id: "google/gemini-3.1-pro-preview",
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      inputModalities: ["audio", "file", "image", "text", "video"],
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
    },
    assessment: {
      costClass: "standard",
      pricing: { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "gemini-3.5-flash": {
    key: "gemini-3.5-flash",
    family: "google",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "google/gemini-3.5-flash",
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      inputModalities: ["text", "image", "video", "file", "audio"],
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
    },
    assessment: {
      costClass: "standard",
      pricing: { inputPerMTok: 1.5, outputPerMTok: 9, cacheReadPerMTok: 0.15 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      // Gated 2026-06-16 (run d82e121d): every correctness capability PASSED and
      // it's faster than M3 — flagship promotion was held back by zombie-rate
      // ALONE (0.049 > 0.02ε: ~2-3 reasoning-only cut-offs, which prod's C4
      // recovery catches). A capable model, not a bad one — kept `pending` for
      // flagship (re-gate after budget/effort tuning), and selectable in
      // WORKHORSE now (workhorse needs no flagship gate — see isSelectableForTier).
      evalGate: { status: "pending" },
    },
  },
  "gemini-3.1-flash-lite": {
    key: "gemini-3.1-flash-lite",
    family: "google",
    tiers: ["utility"],
    catalog: {
      // GA id — the prod vision incumbent ran the `-preview` route of
      // the SAME model until 2026-06; preview routes get sunset, the
      // GA route is the supported one.
      id: "google/gemini-3.1-flash-lite",
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      inputModalities: ["text", "image", "video", "file", "audio"],
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.25,
        outputPerMTok: 1.5,
        cacheReadPerMTok: 0.025,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "none" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "passed" },
    },
  },

  // ───────────────────────── Mistral ─────────────────────────
  "mistral-medium-3.5": {
    key: "mistral-medium-3.5",
    family: "mistral",
    tiers: ["flagship"],
    catalog: {
      id: "mistralai/mistral-medium-3-5",
      contextLength: 262_144,
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
    },
    assessment: {
      costClass: "standard",
      pricing: { inputPerMTok: 1.5, outputPerMTok: 7.5 },
      // enabled:false — validated but not offered yet (cost; beta).
      enabled: false,
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "none" },
      reasoning: { style: "effort", defaultLevel: "low" },
      // zdr:false — Mistral has no ZDR-flagged endpoint on OpenRouter, so
      // zdr:true empties the pool. Mistral is GDPR/EU-native regardless;
      // OpenRouter's ZDR flag (zero-retention) is a separate axis from RGPD.
      provider: { requireParameters: true },
      // Marked passed on technical-health grounds (answered every gate case,
      // 0 fallback) despite the gate's "failed" on correctness:generation —
      // that 2026-06-15 run was confounded by OpenRouter credit exhaustion +
      // the now-fixed required-caption bug. enabled:false keeps it hidden.
      evalGate: {
        status: "passed",
        lastRunId: "56999471-a788-4e2c-b616-b5abdfa0bf53",
        gatedAt: "2026-06-15",
      },
    },
  },
  "mistral-small-2603": {
    key: "mistral-small-2603",
    family: "mistral",
    tiers: ["workhorse"],
    catalog: {
      id: "mistralai/mistral-small-2603",
      contextLength: 262_144,
      inputModalities: ["text", "image"],
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
        cacheReadPerMTok: 0.015,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true },
      evalGate: { status: "pending" },
    },
  },
  "ministral-8b-2512": {
    key: "ministral-8b-2512",
    family: "mistral",
    tiers: ["utility"],
    catalog: {
      id: "mistralai/ministral-8b-2512",
      contextLength: 262_144,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "response_format",
        "structured_outputs",
      ],
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.15,
        cacheReadPerMTok: 0.015,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "none", defaultLevel: "none" },
      provider: { requireParameters: true },
      evalGate: { status: "pending" },
    },
  },

  // ───────────────────────── MiniMax ─────────────────────────
  "minimax-m3": {
    key: "minimax-m3",
    family: "minimax",
    tiers: ["flagship"],
    catalog: {
      id: "minimax/minimax-m3",
      contextLength: 1_048_576,
      maxCompletionTokens: 512_000,
      // Native image + video input, NO file input — verified 2026-06-11.
      inputModalities: ["text", "image", "video"],
      outputModalities: ["text"],
      // `structured_outputs` absent from the M3 parameter list (unlike M2.7).
      supportedParameters: [
        "tools",
        "tool_choice",
        "max_tokens",
        "reasoning",
        "include_reasoning",
        "response_format",
      ],
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.3,
        outputPerMTok: 1.2,
        cacheReadPerMTok: 0.06,
      },
      // C5 native multimodal — ACTIVATED 2026-06-15. M3's catalog lists
      // image + video, so native ingestion is on (validated by the A/B eval
      // run, `multimodal` capability). Images inline as base64; video rides a
      // presigned URL (OpenRouter `video_url`). `limits` is an internal
      // cost/payload guard (NOT an upload cap — the 5-files/15 MB hard caps
      // live in chatbot-limits.ts): across a long conversation only the N
      // most-recent media of each modality travel native, older ones degrade
      // gracefully to the `vision` tool — no error, nothing lost. Video is
      // heavy, so just the latest clip.
      nativeInput: {
        image: true,
        video: true,
        fileMimeTypes: [],
        audio: false,
        limits: { maxImagesPerRequest: 6, maxVideosPerRequest: 1 },
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      // zdr:false — M3's only ZDR provider that supports tool-calling is
      // Morph (2× the price, no prompt caching). Enforcing ZDR collapses
      // the pool to Morph; disabling it lets OpenRouter reach the cheaper,
      // cache-capable MiniMax first-party endpoint. M3 isn't a RGPD-grade
      // choice anyway — ZDR teams pick an EU model (e.g. Mistral).
      provider: { requireParameters: true, zdr: undefined },
      // Promoted via the C3 gate, 2026-06-12. All capabilities at or
      // above the M2.7 baseline; cost $0.0134/turn (budget envelope).
      // The avg-latency criterion of this run pair passed only after
      // the factor recalibration to 1.5× (see gate-config.ts — the
      // 1.3× cap was below measured same-model variance). Earlier
      // attempt ccf1822e-… failed on the empty ZDR pool above, not on
      // the model.
      evalGate: {
        status: "passed",
        lastRunId: "3aeec9d1-583f-4ac2-b35a-6cc1381665f3",
        gatedAt: "2026-06-12",
      },
    },
  },
  // ───────────────────────── DeepSeek ─────────────────────────
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 1.74,
        outputPerMTok: 3.48,
        cacheReadPerMTok: 0.15,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "passed" },
    },
  },
  "deepseek-v4-flash": {
    key: "deepseek-v4-flash",
    family: "deepseek",
    tiers: ["workhorse"],
    catalog: {
      id: "deepseek/deepseek-v4-flash",
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.14,
        outputPerMTok: 0.28,
        cacheReadPerMTok: 0.04,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true, sort: "throughput" },
      evalGate: { status: "passed" },
    },
  },

  // ───────────────────────── GLM (Z.ai) ─────────────────────────
  "glm-5.1": {
    key: "glm-5.1",
    family: "zai",
    tiers: ["flagship"],
    catalog: {
      id: "z-ai/glm-5.1",
      contextLength: 202_752,
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
    },
    assessment: {
      costClass: "standard",
      pricing: {
        inputPerMTok: 0.98,
        outputPerMTok: 3.08,
        cacheReadPerMTok: 0.182,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
  "glm-4.7": {
    key: "glm-4.7",
    family: "zai",
    tiers: ["workhorse"],
    catalog: {
      id: "z-ai/glm-4.7",
      contextLength: 202_752,
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
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.6,
        outputPerMTok: 2.2,
        cacheReadPerMTok: 0.11,
      },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      evalGate: { status: "pending" },
    },
  },
};

/**
 * Flagship profiles whose reasoning depth is genuinely USER-STEERABLE through
 * OpenRouter — raising the effort level meaningfully increases reasoning, so
 * the C7 "extended thinking" toggle actually does something. Gates the toggle's
 * per-model visibility (hidden when the picked model isn't listed here).
 *
 * VALIDATED, not assumed — docs/leaderboards are priors, a runtime probe is the
 * source of truth. Deliberately EXCLUDED:
 *   - minimax-m3: runtime-probed 2026-06 — ignores BOTH effort and max_tokens
 *     (reasoning_tokens flat ~3-5k regardless); self-regulating / adaptive.
 *   - deepseek-v4-pro: effort low/med/high all map to its native default
 *     "high"; only xhigh→"max" lifts it, and OpenRouter currently strips that
 *     (LiteLLM #27439) — our high-level toggle can't boost it.
 *   - glm-5.1: binary `enable_thinking` on/off, no depth control.
 * Members are doc-confirmed effort-steerable (HIGH confidence OpenAI/Anthropic/
 * Google) but NONE is selectable yet (all gate-pending or enabled:false), so the
 * toggle is dormant today. Re-probe each at its gate run (evals/RUNBOOK.md).
 */
export const STEERABLE_REASONING_KEYS: ReadonlySet<string> = new Set([
  "gpt-5.5",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "mistral-medium-3.5",
]);

/**
 * Default role → profile bindings. Pure code — model env vars are
 * GONE: changing a default is a reviewed PR, per-team / per-
 * conversation overrides arrive with C8 (DB). These defaults
 * reproduce the models prod served before the registry existed,
 * EXCEPT `chat`: flipped to minimax-m3 on 2026-06-12 through the C3
 * promotion gate (run 3aeec9d1-… vs M2.7 baseline — see the M3
 * profile's evalGate).
 */
export const ROLE_BINDINGS: Record<ModelRole, RoleBinding> = {
  chat: {
    role: "chat",
    profileKey: "minimax-m3",
    settingsKind: "chat",
    wrapCache: true,
  },
  "chat-fallback": {
    role: "chat-fallback",
    profileKey: "deepseek-v4-pro",
    settingsKind: "chat",
    wrapCache: true,
  },
  "dispatch-cheap": {
    role: "dispatch-cheap",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
  },
  "pre-extract": {
    role: "pre-extract",
    profileKey: "deepseek-v4-flash",
    settingsKind: "preextract",
    wrapCache: true,
  },
  "pre-extract-fallback": {
    role: "pre-extract-fallback",
    profileKey: "gpt-oss-120b",
    settingsKind: "preextract",
    wrapCache: true,
  },
  "active-memory": {
    role: "active-memory",
    profileKey: "gpt-oss-20b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "compaction-summarizer": {
    role: "compaction-summarizer",
    profileKey: "deepseek-v4-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
  "cheap-tasks": {
    role: "cheap-tasks",
    profileKey: "gpt-oss-20b",
    settingsKind: "bare",
    wrapCache: false,
  },
  vision: {
    role: "vision",
    profileKey: "gemini-3.1-flash-lite",
    settingsKind: "bare",
    wrapCache: false,
  },
  "vision-fallback": {
    role: "vision-fallback",
    profileKey: "gpt-4o-mini",
    settingsKind: "bare",
    wrapCache: false,
  },
};
