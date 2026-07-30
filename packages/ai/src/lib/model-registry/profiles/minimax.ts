import type { ModelProfile } from "../types";

/**
 * MiniMax — M3, the current applied `chat` / `workflow` default. Catalog
 * synced from the OpenRouter models API 2026-07-26 (context window and output
 * cap both grew since the 2026-06-11 sync: 524k → 1 048 576 and 65k → 512k).
 */
export const MINIMAX_PROFILES: Record<string, ModelProfile> = {
  "minimax-m3": {
    key: "minimax-m3",
    family: "minimax",
    tiers: ["flagship"],
    catalog: {
      id: "minimax/minimax-m3",
      contextLength: 1_048_576,
      maxCompletionTokens: 512_000,
      // Native image + video input, NO file input — re-verified 2026-07-26.
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
      // No `supportedEfforts`: M3 exposes no effort ladder at all, which is the
      // catalog-level confirmation of what the C7 probe found empirically —
      // reasoning_tokens stayed flat ~3-5k across every effort value. Hence
      // `style: "max-tokens"` and no C7 steering toggle.
      reasoning: { mandatory: false },
    },
    assessment: {
      costClass: "budget",
      pricing: {
        inputPerMTok: 0.3,
        outputPerMTok: 1.2,
        cacheReadPerMTok: 0.06,
      },
      aaSlug: "minimax-m3",
      // 23 964 output tokens per AA task — roughly double GPT-5.6 Luna @xhigh.
      // This is why M3 looks 4th-cheapest by headline price but ranks 7th by
      // real per-task cost: the verbosity, not the $0.30/$1.20, sets the bill.
      verbosity: { outputTokensPerTask: 23_964, reasoningToAnswerRatio: 1.06 },
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
      // maxTokens:5000 — M3 is adaptive and ignores the effort knob; on hard
      // turns it over-thinks (observed: 38 679 reasoning tokens in one step,
      // a full Python script inside a single `<think>` block). The level
      // budget (1 500 at `low`) was too small for the provider to honour; a
      // larger explicit cap is the lever that tamed MiniMax M2.7, so we pin
      // 5 000 here. Re-verify M3 actually respects it (the C7 probe found it
      // ignored 1 500).
      reasoning: {
        style: "max-tokens",
        defaultLevel: "low",
        maxTokens: 5_000,
        // Replayed reasoning is POISON for M3's tool-calling: with its own
        // past <think> blocks in history it hits the documented MiniMax
        // "understanding-execution gap" — announces the tool call in text,
        // then emits EOS instead of the call (prod zombies 2026-07-22/23,
        // sessions 019f8ad8/019f8eb3). Controlled replay of the dead prod
        // request (gen-1784805816, n=5 per variant): reasoning replayed →
        // 4/5 tool calls; stripped → 5/5, zero new reasoning tokens, 2-3×
        // faster steps. Stripping also stops the ×2+ per-turn context
        // inflation. Novita ignored `reasoning.max_tokens` outright, so the
        // budget above could not contain it either way; whether the upstreams
        // pinned below honour it is UNVERIFIED (probed 2026-07-26, but M3
        // never reached the cap on the probe prompt — inconclusive).
        replayInHistory: false,
      },
      // `order: ["Novita"]` — Novita SPLITS the `</think>` boundary while
      // streaming (opening chunk of the answer lands on the `reasoning`
      // channel, `content` resumes mid-word at `\n\n` + the remainder), but
      // it is the only ZDR upstream that is both fast and reliably up:
      // DeepInfra is slow enough that streams cut mid-response, and
      // Parasail/AtlasCloud were unstable. The leak is contained downstream —
      // `stripOrphanThinkTags` (`../resolve.ts`) strips the dangling tag from
      // both streamed deltas and persisted history — so the corrupted-text
      // failure mode from 2026-07-26 (prod 9/50 turns) no longer reaches the
      // user or gets written to history; only latency/availability trade off
      // here, not correctness.
      provider: {
        requireParameters: true,
        zdr: true,
        order: ["Novita"],
      },
      enabled: true,
      // Promoted via the C3 gate, 2026-06-12. All capabilities at or
      // above the M2.7 baseline; cost $0.0134/turn (budget envelope).
      // The avg-latency criterion of this run pair passed only after
      // the factor recalibration to 1.5× (see gate-config.ts — the
      // 1.3× cap was below measured same-model variance). Earlier
      // attempt ccf1822e-… failed on the empty ZDR pool above, not on
      // the model.
      //
      // This stamp is now load-bearing for a different reason: M3 is bound as
      // the `chat` + `workflow` default, and `model-registry.test.ts` requires
      // every default-bound profile to carry `status: "passed"`.
      evalGate: {
        status: "passed",
        lastRunId: "3aeec9d1-583f-4ac2-b35a-6cc1381665f3",
        gatedAt: "2026-06-12",
      },
    },
  },
};
