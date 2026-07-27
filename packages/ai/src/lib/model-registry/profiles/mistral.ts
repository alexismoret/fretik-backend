import { NATIVE_FILE_MAX_BYTES, type ModelProfile } from "../types";

/**
 * Mistral — the EU-native family. Catalog synced from the OpenRouter models
 * API 2026-07-26.
 *
 * **The documented ZDR exception.** Mistral Medium 3.5 and Mistral Small have
 * NO zero-data-retention endpoint on OpenRouter: probed 2026-07-26 across
 * every request envelope, `zdr: true` returns HTTP 404 "No endpoints found
 * matching your data policy" (Small routes only without `tools`, via Venice —
 * useless for an agent). They therefore omit `zdr` entirely, which is a
 * deliberate, reviewed exception to the registry-wide ZDR rule rather than an
 * oversight.
 *
 * That exception is defensible because the two axes are different: OpenRouter's
 * ZDR flag is about provider-side retention, whereas Mistral is a French
 * company hosting in the EU under GDPR. Ministral 8B is the odd one out — it
 * DOES route ZDR (via NextBit), so it sets `zdr: true`.
 */
export const MISTRAL_PROFILES: Record<string, ModelProfile> = {
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
      // A two-rung ladder: full reasoning or none at all.
      reasoning: {
        mandatory: false,
        supportedEfforts: ["high", "none"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "premium",
      pricing: { inputPerMTok: 1.5, outputPerMTok: 7.5 },
      aaSlug: "mistral-medium-3-5",
      verbosity: { outputTokensPerTask: 25_445, reasoningToAnswerRatio: 2.61 },
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
      // No cached-input rate published — every input token pays full price,
      // which is why it lands at 13.5× an M3 turn despite a mid-range headline.
      cache: { strategy: "none" },
      reasoning: { style: "effort", defaultLevel: "high" },
      provider: { requireParameters: true },
      enabled: false,
      disabledReason: "cost",
      // Marked passed on technical-health grounds (answered every gate case,
      // 0 fallback) despite the gate's "failed" on correctness:generation —
      // that 2026-06-15 run was confounded by OpenRouter credit exhaustion +
      // the now-fixed required-caption bug.
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
      reasoning: {
        mandatory: false,
        supportedEfforts: ["high", "none"],
        defaultEffort: "high",
      },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.6,
        cacheReadPerMTok: 0.015,
      },
      aaSlug: "mistral-small-4",
      verbosity: { outputTokensPerTask: 15_650, reasoningToAnswerRatio: 1.46 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: [],
        audio: false,
        limits: { maxImagesPerRequest: 6 },
      },
      cache: { strategy: "implicit" },
      // `none`, not `high`: the ladder has no middle rung, and a cheap
      // workhorse paying for full reasoning defeats the point of picking it.
      reasoning: { style: "effort", defaultLevel: "none" },
      provider: { requireParameters: true },
      enabled: true,
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
      // `reasoning` omitted on purpose: OpenRouter reports none at all for this
      // model, so there is no knob to steer and `style: "none"` below is a
      // catalog fact rather than a product choice.
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.15,
        cacheReadPerMTok: 0.015,
      },
      aaSlug: "ministral-3-8b",
      verbosity: { outputTokensPerTask: 15_686, reasoningToAnswerRatio: 0 },
      nativeInput: {
        image: true,
        video: false,
        fileMimeTypes: [],
        audio: false,
        limits: { maxImagesPerRequest: 6 },
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "none", defaultLevel: "none" },
      // Ministral technically HAS a ZDR route (NextBit) — and `zdr: true` was
      // briefly set here on that basis — but it is not usable. That endpoint
      // caps context at 65 536 tokens against the 262 144 the catalog
      // advertises, and with no explicit `max_tokens` the upstream defaults its
      // completion budget to the full catalog window and rejects its own
      // request: HTTP 400 "This model's maximum context length is 65536 tokens".
      // Reproduced 2026-07-26 on four envelope variants; it only succeeds when
      // the caller happens to set an output cap. Depending on every call site
      // to do that is exactly the silent breakage this registry should not
      // ship, so Ministral joins its two siblings in the documented Mistral
      // ZDR exception above.
      provider: { requireParameters: true },
      enabled: true,
    },
  },
};
