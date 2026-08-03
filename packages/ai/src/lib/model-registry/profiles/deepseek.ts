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
 * - **The most verbose family we ship** — 37-41k output tokens per AA task.
 *   Kept on `style: "max-tokens"` for that reason (see below).
 * - **ZDR pool, re-probed 2026-08-02** (enumerated by successive `ignore`):
 *   V4 Flash routes DeepInfra → Novita → SiliconFlow → Parasail → Fireworks →
 *   Mancer 2, then 404. The 2026-07-26 note claiming Novita is the only ZDR
 *   route was wrong for this family; V4 Pro still routes DeepSeek-first.
 * - **No `</think>` leak.** Probed 5/5 ZDR upstreams under streaming with a
 *   reasoning-heavy prompt: zero `<think>`/`</think>` fragments on the
 *   `content` channel, Novita included. The boundary bug documented on
 *   `minimax-m3` is specific to M3-on-Novita, not to Novita — so this family
 *   needs neither a `provider.ignore` nor the orphan-tag stripper.
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
      // CORRECTED 2026-08-03. Was $0.435/$0.87/$0.0036 — DeepSeek's own
      // first-party endpoint, which is NOT IN THE ZDR POOL. We could never be
      // billed at it. Probing the real envelope enumerates the reachable pool
      // as Parasail / Ionstream / Novita / Venice / Together / DeepInfra /
      // DigitalOcean / CoreWeave, priced $1.13-1.74 in and $0.094-0.348 cached.
      // The values below are the MEDIAN of that pool — three consecutive probes
      // served DeepInfra, then DigitalOcean, then CoreWeave, so no single
      // endpoint is "the" price here.
      //
      // The old cached rate was the damaging one: at 0.83 % of input it was an
      // order of magnitude below the fleet, and since a Fretik turn is
      // cache-read dominated it made this model rank CHEAPER than MiniMax M3
      // when it is ~3× dearer. costLevel 27 → 51, `low` → `moderate`.
      // Superseded at runtime by the live routed price
      // (`services/model-metrics/fetch-openrouter-routing.ts`); this is the
      // reviewed baseline and the offline fallback.
      pricing: {
        inputPerMTok: 1.521,
        outputPerMTok: 3.043,
        cacheReadPerMTok: 0.1175,
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
  // V4 Flash 0731 — a DIFFERENT model from the April V4 Flash, not a revision:
  // OpenRouter ships it under its own id and Artificial Analysis re-pointed the
  // `deepseek-v4-flash` SLUG at it (the April one became `deepseek-v4-flash-0420`).
  // That rebind is why this swap was not optional: while the profile still
  // carried the April catalog id, `aaSlug` was already resolving to 0731's
  // numbers, so the hub card mixed one model's intelligence with the other's
  // latency. Same architecture (284B total / 13B active) and same list price,
  // but +9.6 AA intelligence (49.9 vs 40.3) and 2.4× tool-use.
  //
  // The KEY is deliberately unchanged. It is the persistence contract for
  // `team_ai_settings.*_profile_key`, `ai_conversations.model_profile_key` and
  // `workflows.model_profile_key`; renaming it would not crash anything
  // (`resolveTierProfileKey` degrades) but every team that had chosen this
  // model would silently fall back to the code default.
  "deepseek-v4-flash": {
    key: "deepseek-v4-flash",
    family: "deepseek",
    tiers: ["flagship", "workhorse"],
    catalog: {
      // Pinned, never the `~deepseek/deepseek-v4-flash-latest` alias: an alias
      // would swap the model under us and void the eval-gate contract.
      id: "deepseek/deepseek-v4-flash-0731",
      contextLength: 1_048_576,
      // 65 536, down from the April model's 393 216 — this is DeepInfra's cap,
      // and DeepInfra is both the cheapest endpoint and the one pinned below.
      maxCompletionTokens: 65_536,
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
      // NO `supportedEfforts`, even though every 0731 endpoint now advertises
      // `reasoning_effort` — the catalog claim is not honoured by any upstream
      // in our ZDR pool. Measured 2026-08-02, n=3 per cell on a hard prompt:
      // DeepInfra `minimal` 3 733 vs `xhigh` 4 261 reasoning tokens, Novita
      // 6 152 vs 5 601 — noise, not a ladder. `supportedEfforts` feeds
      // `selectableReasoningLevels`, i.e. the depth menu a user actually sees,
      // so recording an unhonoured ladder would ship a control that does
      // nothing. Same reason M3 carries none.
      reasoning: { mandatory: false },
    },
    assessment: {
      costClass: "budget",
      // CORRECTED 2026-08-03 to the PINNED DeepInfra route. This used to carry
      // the list price ($0.14/$0.28/$0.028) on the argument that pricing the
      // fleet at cheapest-route would make `costLevel` incomparable — but an
      // audit of all 22 profiles showed the opposite was already true: every
      // other profile records the endpoint it actually routes to (M3 at
      // Novita's price, the OpenAI family at Azure's, GLM at DeepInfra's). This
      // was the only list-priced profile, so it overstated the default
      // flagship by 1.56× against a fleet priced on a different basis.
      pricing: {
        inputPerMTok: 0.09,
        outputPerMTok: 0.18,
        cacheReadPerMTok: 0.018,
      },
      // AA re-pointed this slug at 0731 — see the note above.
      aaSlug: "deepseek-v4-flash",
      // DERIVED, not published: AA exposes per-task output tokens only on the
      // website, and the 0731 page currently shows just the 210M index-run
      // total. Implied task count from the April model (234M / 45 277 ≈ 5 168)
      // gives 210M / 5 168 ≈ 40 634 — a ~12 % drop, consistent with AA's own
      // "12% fewer output tokens" claim. Replace with the published per-task
      // figure when AA exposes it. Load-bearing: this is the only field
      // `cost-level.ts` reads beyond price, and verbosity moves a model up to
      // 8 rank positions.
      // The ratio is measured on our own probes (~1.7 across 4 hard-prompt
      // runs), well below the April model's AA-derived 3.32.
      verbosity: { outputTokensPerTask: 40_634, reasoningToAnswerRatio: 1.7 },
      nativeInput: {
        image: false,
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      cache: { strategy: "implicit" },
      reasoning: { style: "max-tokens", defaultLevel: "low" },
      provider: {
        requireParameters: true,
        zdr: true,
        sort: "throughput",
        // `order: ["DeepInfra"]` — the upstream choice dominates every
        // reasoning knob on this model. Measured 2026-08-02 with the EXACT
        // chat envelope (require_parameters + zdr + reasoning.max_tokens 1500),
        // same hard prompt, pinned without fallback, median reasoning tokens /
        // median latency / median cost:
        //   DeepInfra  (fp4)      1 512 /  19.8s / $0.00041
        //   Parasail   (fp8)      2 141 / 204.8s / $0.00102
        //   Fireworks  (unknown)  8 360 / 151.3s / $0.00350
        //   SiliconFlow(fp8)      8 707 /  64.1s / $0.00252
        //   Novita     (fp8)      9 914 /  75.4s / $0.00285
        // DeepInfra's range (873-3 528) does not even overlap Novita's
        // (6 651-21 516). Quality is flat across all of them — 15/15 on
        // arithmetic, strict-JSON format discipline and real tool calls
        // (name + argument checked), so the fp4 serving costs nothing
        // measurable on the failure modes quantization usually causes. Those
        // checks do NOT probe deep reasoning; the eval suite does, and it runs
        // on this routing. `allow_fallbacks` stays on, so this is a preference,
        // not a single point of failure.
        order: ["DeepInfra"],
      },
      enabled: true,
      // Promoted to the `chat` + `workflow` default 2026-08-02, full curated
      // suite (80 cases) against the minimax-m3 baseline: PASS, 0 failing
      // criteria. reasoning 0.963→0.981, tool-use 0.976→0.988, objects
      // unchanged, avg latency 56 325→30 846 ms, $0.0053/turn vs M3's $0.0153,
      // and it fell over to the fallback agent LESS than the incumbent (1 vs 2).
      //
      // The first two gate attempts failed on `fallback-served` under an
      // ABSOLUTE cap of 1. Two things fixed that, in this order: a prompt
      // defect (the "decide, then call" rule existed only as narrow special
      // cases, so any model could announce an action and stop — see
      // `agent-system-prompt.md`), and the criterion itself, which the
      // RUNBOOK's own self-test proved unpassable — minimax-m3 measured
      // against its own baseline also scored 2. It is now baseline-relative
      // like every other criterion (`gate-config.ts`).
      //
      // KNOWN REGRESSION, accepted with eyes open: EXTRACTION. The gate read
      // 0.964 → 0.821; two dedicated `--capability extraction` runs then
      // measured 0.869 twice, byte-identical (pass-rate 0.714, 0 fallbacks).
      // So it is NOT judge noise on this subset — it is a real, reproducible
      // ~0.1 gap against M3, worth ~0.67 case-equivalents, inside the ≤1
      // threshold but on a capability central to this product. It is the price
      // of the switch, not a measurement artefact: revisit it if extraction
      // quality complaints appear, and re-check it first when this profile is
      // next gated. generation 1.000→0.933 and instruction-following
      // 1.000→0.944 are the other two, both inside threshold.
      evalGate: {
        status: "passed",
        lastRunId: "8e3ea13a8b4b3968",
        gatedAt: "2026-08-02",
      },
    },
  },
};
