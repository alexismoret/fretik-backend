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
      // Pinned to the DATED snapshot (2026-08-29), like `deepseek-v4-flash`
      // below and for the same reason: an undated alias moves under us, so the
      // model a team benched is not necessarily the one it runs a month later.
      // Both catalogues carry this id — 16 OpenRouter endpoints, and the
      // Gateway lists it alongside the April snapshot at identical context and
      // price.
      id: "deepseek/deepseek-v4-pro-0813",
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
      // 1 310 720 since 2026-08-26, up from 1 048 576. The product READS this
      // one: `getCompactionThresholdTokens` is `contextLength` minus the
      // summariser reserve and the autocompact buffer, so the turn that
      // triggers compaction on this model now sits ~262K later.
      contextLength: 1_310_720,
      // Tracks `top_provider`, i.e. whichever endpoint currently LEADS the
      // routing — not a floor. The previous 65 536 was DeepInfra's cap back
      // when this profile pinned DeepInfra alone; since 2026-08-05 it routes
      // across a three-endpoint pool (see `assessment.pricing`), so that
      // number described a provider the profile no longer always reaches.
      maxCompletionTokens: 943_718,
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
      // MEDIAN OF THE VETTED POOL since 2026-08-05, replacing DeepInfra's
      // $0.09/$0.18/$0.018. The rule is unchanged — price the endpoint the
      // profile actually routes to — but this profile no longer routes to ONE
      // endpoint: `provider.only` + `sort` choose per request among BaseTen
      // ($0.130/$0.260), Venice ($0.175/$0.350) and DeepInfra ($0.090/$0.180),
      // so the median is what we pay on average. A live probe the same day
      // resolved $0.1325/$0.265/$0.0265 (median of 2, BaseTen rate-limiting) —
      // this within noise.
      //
      // Honest about the direction: this is a real ~1.47× on `cacheReadPerMTok`,
      // and a Fretik turn is cache-read dominated, so `costLevel` rises with it.
      // What it buys is a measured 4× on completion time whenever the sort lands
      // on BaseTen or Venice (14.9-15.5s vs DeepInfra's 62.0s for 4 096 tokens).
      // Superseded at runtime by the live routed price
      // (`services/model-metrics/fetch-openrouter-routing.ts`).
      pricing: {
        inputPerMTok: 0.13,
        outputPerMTok: 0.26,
        cacheReadPerMTok: 0.028,
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
        // `sort` + `only`, NOT a pin. Re-measured 2026-08-06 with
        // `bun run models:bench` over 9 candidates plus a COST-based cache probe
        // (three identical 75k prefixes, reading `usage.cost` rather than the
        // self-reported `cached_tokens`, which a provider may simply omit):
        //
        //   upstream      tok/s   best   reason   cached-path cost
        //   siliconflow    86.9   89.5     1119   $0.00147 … or $0.00733
        //   coreweave      86.5  107.0     1543   $0.00680 (never drops)
        //   together       77.4   86.2     2380   $0.00157
        //   phala          71.4   72.5      864   —
        //   novita         65.8   66.4     4096   —
        //   deepinfra      55.9   57.1     2557   $0.00097
        //   venice         43.2   43.5     2343   —
        //   parasail       31.4   33.0     1310   —
        //   baseten           —      —        —   3 × HTTP 429, 0 success
        //
        // VENICE STAYS, but on a corrected basis. Two runs returned 43.2 and
        // 43.5 tok/s — no variance at all — so the "273 tps" below never
        // reproduced, and the note that admitted it was right to suspect its own
        // sample ("bimodal… their aggregate is probably the honest number").
        // It is kept because its OpenRouter p99 is 304, the second highest in
        // the pool: a member the sort does not promote costs nothing, and
        // dropping it would remove the only path by which a genuinely bimodal
        // upstream ever gets used. Do NOT read its presence as a speed claim.
        //
        // TOGETHER IS OUT since 2026-08-13: it MUTILATES answers. Whenever a
        // response ends in tool calls — which every agent turn does — it stops
        // emitting `content` mid-sentence and never sends the tail in any later
        // chunk, so nothing downstream can recover it. Prod evidence over 5 days
        // of `chatbot-turn` generations, same code and same model throughout:
        // 44/50 text parts cut on `finish_reason = tool-calls` (0/14 on `stop`),
        // against 0/25 Venice and 0/5 DeepInfra. Reproduced off the raw wire
        // 3/3, streaming AND non-streaming, so it is generation-side rather than
        // a framing bug in any SDK. Same class as the `</think>` boundary bug on
        // `minimax-m3`, same remedy. The speed and cache numbers that admitted
        // it on 2026-08-06 still hold; they are not worth a truncated answer.
        // `models:bench` now carries this as its `intact` column — re-admit only
        // on a clean reading.
        //
        // Re-benched 2026-08-13, n=3, integrity + cost-based cache:
        //
        //   upstream    intact  tok/s  best   cold $    warm $   429
        //   baseten        0/3  132.3  132.3       —         —     6   ← never served
        //   fireworks      3/3   97.0  100.2  0.00733   0.00147     0
        //   venice         3/3   87.2   92.3  0.00917   0.00184     0
        //   coreweave      3/3   74.1   82.6  0.00680   0.00368     0
        //   together       0/3   55.2   61.2  0.00732   0.00157     0   ← cuts answers
        //   deepinfra      1/3   28.1   34.2  0.00418   0.00086     2
        //
        // FIREWORKS IS IN, and the note it replaces was simply STALE. It was
        // excluded as "HTTP 429" — it now serves 6/6 calls without one, and is
        // the best endpoint here on every axis at once: fastest of those that
        // work, a clean 5.0× cache drop, and by far the tightest reasoning
        // (714 tokens against a 600 budget, where Venice spends 2 802 and
        // DeepInfra 2 082 for the same answer).
        //
        // COREWEAVE IS IN, on a correction and a caveat. The correction: it DOES
        // cache now — $0.00680 → $0.00368 — where the 2026-08-06 probe measured
        // three identical prefixes billed flat and concluded it never did. The
        // caveat: that is a 1.85× drop where every other member gets ~5×, so its
        // warm path is 4.3× DeepInfra's and 2.5× Fireworks'. It is admitted as a
        // ceiling-and-availability option under the pool doctrine below (a member
        // the sort does not promote costs nothing), NOT as a cheap one.
        //
        // DEEPINFRA IS NO LONGER THE SAFE INCUMBENT: 28 tok/s median here, a
        // fifth of its own ceiling, and 2 of its 3 integrity runs came back 429.
        // It stays for its warm price, which is still the cheapest by 1.7×.
        //
        // The two FASTEST upstreams are both rejected, and only the cost probe
        // could show why: CoreWeave bills three identical 75k prefixes at
        // $0.006800 each with `cached_tokens: 0` — it genuinely does not cache,
        // making it 7.0× DeepInfra's cached path for 1.55× the speed.
        // SiliconFlow is worse than that: it cached once ($0.00147) then missed
        // twice within 30 s ($0.00733), so its cost is unpredictable rather than
        // merely high. Novita burned all 4 096 output tokens on reasoning — the
        // answer is never written — which is a hard exclusion, not a preference.
        //
        // Nothing here is pinned with `order`: pinning our own n=3 against
        // OpenRouter's live aggregate is the mistake the 2026-08-05 change
        // undid, and `order` silently disables `sort`.
        //
        // Earlier note (2026-08-05), kept for the reasoning that still holds:
        // the previous `order: ["DeepInfra"]` was pinning the agent to the
        // SLOWEST working upstream — and silently disabling this `sort`, since
        // OpenRouter consults `order` first.
        //
        // The 2026-08-02 note this replaces measured a single hard prompt and
        // read the result as "DeepInfra thinks 6× less than the others". Two
        // things were wrong with it. Reasoning volume is a property of the
        // PROMPT, not the upstream: re-probed with an explicit budget, NO
        // upstream honours `reasoning.max_tokens` (600 requested → 1 015-1 600
        // emitted everywhere), and on ordinary turns the whole pool sits at
        // 38-183 tokens. And it never measured sustained decode, which is what
        // an agent turn is actually made of.
        //
        // Measured on a 4 096-token generation, n=3, median tok/s and total:
        //   BaseTen    (fp8)  283 tps / 14.9s   ← 429s under load, falls over
        //   Venice   (unknown) 273 tps / 15.5s
        //   SiliconFlow (fp8)  115 tps / 36.8s
        //   Novita      (fp8)   98 tps / 42.8s
        //   DeepInfra   (fp4)   67 tps / 62.0s  ← what we were pinned to
        // Time-to-first-token spans only ~0.6s across that pool, so `sort` is
        // on throughput: decode dominates a turn, not TTFT.
        sort: "throughput",
        // The vetted pool. Membership is a CACHE + CONVERGENCE decision, which
        // is why it cannot be left to `sort` alone — a sort sees throughput and
        // nothing else, and on this model the two FASTEST upstreams are the two
        // that do not cache. A miss bills ~4.6× on a Fretik turn ($0.00490 vs
        // $0.00107), so the cache is also why routing must stay STICKY. It does:
        // over 10 consecutive turns the sort served all 10 from one upstream at
        // 10/10 cache hits, so the old fear that sorting thrashes the cache is
        // unfounded.
        //
        // The pool is deliberately WIDER than the set we expect to be served by.
        // `sort` promotes on OpenRouter's live p50, so an upstream that is only
        // occasionally fast can only ever be reached if it is a member — and a
        // member that is never promoted costs nothing. Admission therefore turns
        // on ANSWER INTEGRITY first, then cache and convergence, never on "will
        // it win today".
        //
        // Excluded on measurement: SiliconFlow (erratic cache — hit once then
        // missed twice in 30 s), Novita (reasoning runaway: spent the whole
        // 4 096-token budget with the answer unwritten), Parasail (31 tok/s),
        // Phala (caches and converges best of the lot, but $0.070/MTok
        // cache-read is 3.9× DeepInfra's for 1.28× the decode), Mancer 2 (never
        // caches, dearest), Morph / AkashML / Io Net (17-21 tok/s), Ionstream
        // (HTTP 429), Together (cuts answers — above), Baidu / DeepSeek /
        // Cloudflare / BaseTen-without-ZDR (404 — outside the ZDR pool).
        // Parasail's old "19.5s TTFT" exclusion was a bad sample: OpenRouter
        // puts its latency p50 at 779 ms, second best of all 22.
        //
        // WAFER (`wafer/fast`) and MAKORA, both evaluated 2026-08-28 as
        // replacements for CoreWeave, both REFUSED. Neither corrupts text
        // (0/4 runs on the numeric probe below), and both are ZDR-reachable:
        //
        //   upstream   intact  tok/s   best   warm $    cache behaviour
        //   wafer         0/3  202.8  222.5  0.00368    warms after 1 call
        //   makora        3/3   94.5  126.5  0.00105    2 hits in 8 calls
        //   deepinfra     3/3   29.7   39.9  0.00086    99% from call 1
        //
        // Wafer is the fastest endpoint this model has ever been benched on —
        // 6.8× DeepInfra — and it MUTILATES: 0/3 on the integrity gate, the
        // answer cut mid-sentence at the tool-call boundary, the exact defect
        // that removed Together on 2026-08-13. Every agent turn ends in a tool
        // call, so this is the one column that cannot be traded.
        //
        // Makora passes integrity but its cache FLAPS: 2 hits in 8 calls on a
        // byte-identical 75k prefix (0,0,0,99%,0,0,99%,0), i.e. ~$0.0038 a turn
        // in expectation against DeepInfra's $0.00086. Same class as
        // SiliconFlow above — unpredictable, not merely dear. Note the bench's
        // 2-warm-call cache probe reported a flat "0%" for it; the flapping is
        // only visible at n=8, so re-measure this one with the standalone cost
        // probe rather than the bench column.
        //
        // Neither could be admitted as a harmless "availability option" under
        // the pool doctrine above, and this is worth keeping straight: that
        // argument only holds for a member `sort: "throughput"` will NOT
        // promote. Both of these are FASTER than the incumbent, so the sort
        // would promote them on day one — Wafer into truncated turns, Makora
        // into a 4.4× bill.
        //
        // TWO of those exclusions expired and were reversed on 2026-08-13
        // (CoreWeave's "never caches", Fireworks' "HTTP 429"). An upstream is a
        // moving target: re-bench before quoting a note, never act on its age.
        //
        // BaseTen is IN despite serving 0 of 5 attempts across two benches (all
        // HTTP 429): a 429 inside `only` fails over silently (0 errors reached
        // the caller over 10 turns), so the option costs nothing, and its p99 is
        // 412 tok/s — four times anything else here — when it does serve.
        //
        // COREWEAVE IS OUT since 2026-08-28: it CORRUPTS EMITTED TEXT. It
        // inserts U+200B (zero-width space) — and fullwidth punctuation
        // U+FF09 `）` / U+FF1F `？`, plus the odd Han character — adjacent to
        // NUMERIC tokens. The insertion is positional, not random noise:
        //
        //   Net 1.200, T.Net  <U+200B>4.800, Total <U+200B>314.88
        //
        // taken from the recorded output of gen 639dd333c9873d44 (prod session
        // 01a04855, 12:30:41). The character is in the RAW response body, so it
        // is generation-side, not a framing bug on our side.
        //
        // Reproduced on demand, n=3 per upstream, ~35k context, numeric
        // transcription task, identical request:
        //
        //   upstream    runs corrupted   hits   codepoints
        //   coreweave        2/3          237   U+200B ×220, U+FF1F ×17
        //   deepinfra        0/3            0   —
        //   fireworks        0/2            0   —
        //
        // Why it is a HARD exclusion rather than a preference: the agent writes
        // CODE, and every one of these characters is a syntax error the
        // compiler and the Python kernel refuse (`SyntaxError: invalid
        // non-printable character U+200B`). Worse, the corruption is
        // SELF-PROPAGATING — the model reads its own poisoned output back from
        // the history and keeps copying the bad values, so one hit costs a
        // whole turn: prod session 01a04855 spent 27 tool calls and never
        // produced the file, and 01a03e9b before it burned 7 identical compile
        // refusals on the same defect wearing U+0301 instead.
        //
        // The task matters when re-benching this: two earlier probes asked for
        // a Vue component and found NOTHING at 120k. The defect lands on
        // numbers, so a probe without figures in it cannot see it — and depth
        // is not the trigger either (prod corruption started at 37k input).
        only: ["baseten", "fireworks", "venice", "deepinfra"],
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
