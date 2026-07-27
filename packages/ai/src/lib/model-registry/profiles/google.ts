import { NATIVE_FILE_MAX_BYTES, type ModelProfile } from "../types";

/**
 * Google — Gemini. Catalog synced from the OpenRouter models API 2026-07-26.
 *
 * Family facts:
 * - **The only fully multimodal family we ship.** Every profile here accepts
 *   `text,image,video,file,audio` upstream, so all four visual modalities are
 *   activated natively. `audio` stays off across the whole registry: no call
 *   site produces audio parts yet, so it would be untested surface.
 * - **Reasoning is MANDATORY on 3.6 Flash and 3.5 Flash-Lite** — never send
 *   `none`, OpenRouter rejects it. 3.1 Flash-Lite and 3.1 Pro allow disabling.
 * - **ZDR routes via Google/Vertex.** Vertex is picky about parameters: the
 *   `bare` role envelope deliberately drops `require_parameters` because
 *   pairing it with `zdr` emptied the Vertex pool on `temperature`
 *   (`resolve.ts`). Do not "fix" that by adding it back here.
 * - `gemini-3.5-flash-lite` backs the `vision` role and the `extract` engine;
 *   `gemini-3.1-flash-lite` is its fallback. Both run through `bare`, which
 *   sends no reasoning parameter, so `defaultLevel` below only affects a team
 *   that picks them for chat.
 */
export const GOOGLE_PROFILES: Record<string, ModelProfile> = {
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
      reasoning: {
        mandatory: true,
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2 },
      aaSlug: "gemini-3-1-pro-preview",
      verbosity: { outputTokensPerTask: 13_171, reasoningToAnswerRatio: 3.81 },
      nativeInput: {
        image: true,
        video: true,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxVideosPerRequest: 1,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "implicit" },
      // `medium` — its ladder has no `minimal`/`xhigh` and reasoning cannot be
      // switched off, so the upstream default is also the sane product default.
      reasoning: { style: "effort", defaultLevel: "medium" },
      provider: { requireParameters: true, zdr: true },
      enabled: false,
      disabledReason: "cost",
    },
  },
  "gemini-3.6-flash": {
    key: "gemini-3.6-flash",
    family: "google",
    tiers: ["flagship", "workhorse"],
    catalog: {
      id: "google/gemini-3.6-flash",
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
      reasoning: {
        mandatory: true,
        supportedEfforts: ["high", "medium", "low", "minimal"],
        defaultEffort: "medium",
      },
    },
    assessment: {
      costClass: "standard",
      pricing: {
        inputPerMTok: 1.5,
        outputPerMTok: 7.5,
        cacheReadPerMTok: 0.15,
      },
      aaSlug: "gemini-3-6-flash",
      verbosity: { outputTokensPerTask: 23_307, reasoningToAnswerRatio: 1.21 },
      nativeInput: {
        image: true,
        video: true,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxVideosPerRequest: 1,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "low" },
      provider: { requireParameters: true, zdr: true },
      // Disabled on cost (4.06× an M3 turn), NOT on quality: the 2026-06-16
      // gate run (d82e121d) passed every correctness capability and beat M3 on
      // latency, failing only zombie-rate by 0.03. Still serves
      // `transform-fallback` — `ROLE_BINDINGS` resolves profiles directly and
      // bypasses `isSelectableForTier`, so `enabled: false` blocks user
      // selection without touching internal roles.
      enabled: false,
      disabledReason: "cost",
      evalGate: { status: "pending" },
    },
  },
  "gemini-3.5-flash-lite": {
    key: "gemini-3.5-flash-lite",
    family: "google",
    // Also FLAGSHIP since 2026-07-27, by product decision. It is the weakest
    // model on the flagship menu (AAII ~30 against Luna's 49) and its agentic
    // reliability is unproven on our tool loop — but it is the only flagship
    // option that is multimodal, million-token AND cheaper than the default,
    // which is a legitimate trade for a team whose work is document triage
    // rather than reasoning. Under the open-registry doctrine that call belongs
    // to the team, not to us; the eval gate still guards the applied default.
    tiers: ["flagship", "workhorse", "utility"],
    catalog: {
      id: "google/gemini-3.5-flash-lite",
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
      reasoning: {
        mandatory: true,
        supportedEfforts: ["high", "medium", "low", "minimal"],
        defaultEffort: "minimal",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.3,
        outputPerMTok: 2.5,
        cacheReadPerMTok: 0.03,
      },
      aaSlug: "gemini-3-5-flash-lite",
      verbosity: { outputTokensPerTask: 12_754, reasoningToAnswerRatio: 1.69 },
      nativeInput: {
        image: true,
        video: true,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxVideosPerRequest: 1,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "implicit" },
      // `minimal` matches upstream. Reasoning tokens count against the output
      // cap here, and an over-budget thinking pass is what produced the
      // "No output generated." class of extract failures — keep it low.
      reasoning: { style: "effort", defaultLevel: "minimal" },
      provider: { requireParameters: true, zdr: true },
      enabled: true,
    },
  },
  "gemini-3.1-flash-lite": {
    key: "gemini-3.1-flash-lite",
    family: "google",
    tiers: ["utility"],
    catalog: {
      // Its ZDR endpoint (Vertex) advertises `temperature` — unlike the
      // 3.5-flash-lite route it briefly replaced — so it routes cleanly under
      // the data-retention policy.
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
      // The one Gemini here whose reasoning CAN be disabled.
      reasoning: {
        mandatory: false,
        supportedEfforts: ["high", "medium", "low", "minimal"],
        defaultEffort: "minimal",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.25,
        outputPerMTok: 1.5,
        cacheReadPerMTok: 0.025,
      },
      aaSlug: "gemini-3-1-flash-lite-preview",
      nativeInput: {
        image: true,
        video: true,
        fileMimeTypes: ["application/pdf"],
        audio: false,
        limits: {
          maxImagesPerRequest: 6,
          maxVideosPerRequest: 1,
          maxFilesPerRequest: 2,
          maxFileBytes: NATIVE_FILE_MAX_BYTES,
        },
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "effort", defaultLevel: "none" },
      provider: { requireParameters: true, zdr: true },
      enabled: true,
      evalGate: { status: "passed" },
    },
  },
};
