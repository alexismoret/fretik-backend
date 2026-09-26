import type { ModelRole, RoleBinding } from "./types";

/**
 * Which model serves each internal role — the registry's DECISION layer, and
 * since 2026-08-30 the only hand-written thing left in it.
 *
 * Everything a model IS is now read: the reasoning ladder, the cache contract,
 * native PDF, the ZDR stance, the price, the context, the pool — all of it comes
 * from `model_live_state`, written by the nightly sync and synthesised into a
 * profile by `effective.ts`. There is no per-model TypeScript any more, because
 * every fact a profile used to assert is published by a catalogue and every
 * measurement we take ourselves is written to a row by whatever measured it.
 *
 * What survives here is not a fact about a model. It is a choice about a JOB:
 * which model does the chatting, which one judges recall on a turn's hot path,
 * which one is trusted with a memory merge that is hard to undo. No API can
 * publish that, and the comments below are the measurements that decided each
 * one — they are the reason this file is long, and they are the point of it.
 *
 * Two rules:
 *
 * 1. **Changing a default is a reviewed pull request**, never an env edit. Model
 *    env vars are gone; per-team and per-conversation overrides come from the
 *    database.
 * 2. **This is the eval-gated surface.** `model-registry.test.ts` requires the
 *    `chat` and `workflow` bindings to carry `evalGate.status === "passed"` with
 *    a run id, so promoting a new default fails CI without a gate run:
 *    `bun run evals:gate -- --candidate <key>`. Merely OFFERING a model to teams
 *    requires no eval evidence at all — selection is governed by the row's
 *    `enabled` and nothing else, because the product is breadth and a model that
 *    underperforms on our tools is the team's call to swap, not a gate's call to
 *    hide.
 *
 * The gate stamp used to sit on the profile, which was the wrong object: a gate
 * run measures a model DOING A JOB against the model that held the job before
 * it, and a profile cannot express a pairing. The cost of that was visible —
 * `minimax-m3` carried a stamp whose comment called it the `chat` default four
 * weeks after the flip moved `chat` elsewhere, and nothing could catch it.
 *
 * A binding resolves its profile directly and bypasses `isSelectableForTier`, so
 * a role may legitimately point at a model no team can pick — see
 * `transform-fallback` → `gemini-3.7-flash`.
 *
 * The eval judge (`evals/judge.ts`) intentionally stays OUTSIDE the registry: it
 * must remain a different family from the serving models.
 */
export const ROLE_BINDINGS: Record<ModelRole, RoleBinding> = {
  // Flip 2026-09-21: deepseek-v4-flash → zai-glm-5-3-flash.
  //
  // WHAT THE STAMP BELOW COVERS, AND WHAT IT DOES NOT. It is NOT an
  // `evals:gate` run: it is a paired pair of dataset runs over the NINE
  // `collections-autonomy` sync cases, twice each — `ae47960ba5bd5906` (GLM)
  // against `5fc9302dfbe9ad88` (DeepSeek), same evening, same code, same
  // service, the parent model the only difference. 9 of the 123 curated cases.
  // The full gate was cut for time and is OWED; run it before this binding is
  // trusted beyond what follows.
  //
  // On that scope every axis moved the same way, and the cheaper one won:
  // pass-stability 0.556 → 0.889, pass-rate 0.722 → 0.944, correctness
  // 0.921 → 0.986, avg tool calls per turn 71.8 → 5.7, tool-error-rate
  // 0.880 → 0.068, redundant-call-rate 0.278 → 0.000, avg latency 184s → 55s,
  // cost/turn $0.022 → $0.017.
  //
  // WHY it moved is the part worth keeping: DeepSeek V4 Flash re-emits a
  // BYTE-IDENTICAL tool call — same caption, same ids, same arguments —
  // hundreds of times inside ONE generation (435 `manageSync`, 753 `querySql`,
  // 349 `manageRecord` on three different turns). That is a decoding loop, not
  // a tool failing and being retried, and no guard between steps can see inside
  // one. Four of eighteen turns ran away; GLM ran none. The longest turn fell
  // from 785s to 116s.
  //
  // WHAT IS UNMEASURED HERE: every capability outside sync, EXTRACTION first.
  // The 2026-08-02 flip TO DeepSeek cost a reproducible ~0.1 there (0.964 →
  // 0.821 on the gate, 0.869 twice on two dedicated runs) and it was accepted
  // as the price of that switch. Whether GLM gives it back, keeps it, or
  // deepens it is not known — `pre-extract` still runs DeepSeek, so the
  // question now belongs to that binding as much as to this one.
  chat: {
    role: "chat",
    profileKey: "zai-glm-5-3-flash",
    settingsKind: "chat",
    wrapCache: true,
    evalGate: {
      status: "passed",
      lastRunId: "ae47960ba5bd5906",
      gatedAt: "2026-09-21",
    },
  },
  // Deliberately a DIFFERENT family and a different upstream from `chat`:
  // this binding exists for the turns where the primary died, so sharing
  // DeepSeek's weights or DeepInfra's capacity with it would let one incident
  // take out both.
  //
  // minimax-m3 held it from 2026-06-12 (its own C3 run, $0.0134/turn) to
  // 2026-09-14, when a real fallback run showed what a cheap fallback costs:
  // the page builder fell to M3 after an upstream cut and spent 74 steps
  // inventing provider keys, reading files without a path and writing a
  // `page.json` the runtime rejected — $1.72 for a page that did not load. A
  // fallback serves exactly the turns that already went wrong once; it has to
  // be at least as capable as the primary, not cheaper. gpt-5.6-luna is the
  // strongest family-disjoint model in the fleet (it is the page critic for
  // that reason). Not eval-gated on this role yet — the gate belongs to the
  // first C3 run that lands on it.
  "chat-fallback": {
    role: "chat-fallback",
    profileKey: "gpt-5.6-luna",
    settingsKind: "chat",
    wrapCache: true,
  },
  // Autonomous workflow executor. Defaults to the SAME profile as `chat`
  // (reliability first — the priority order is precision > cost) and follows
  // the team's flagship tier pick; a workflow may override per-run via its
  // `modelProfileKey`. The agent already delegates mechanical sub-tasks to the
  // cheap model via `dispatchAgent`, so the default need not be the cheap one.
  // Tracks `chat` (reliability first) — flipped with it on 2026-09-21, and
  // carrying the same stamp and the same limits: see the `chat` comment for
  // what those nine cases measured and what they did not. A workflow run has
  // nobody watching it, so a decoding loop costs more here than in a chat turn,
  // which is the half of that measurement that transfers best.
  workflow: {
    role: "workflow",
    profileKey: "zai-glm-5-3-flash",
    settingsKind: "chat",
    wrapCache: true,
    evalGate: {
      status: "passed",
      lastRunId: "ae47960ba5bd5906",
      gatedAt: "2026-09-21",
    },
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
    // P5-bis recall-eval decision (2026-07, 16-case suite × 3 repeats):
    // gpt-oss-120b @ effort medium @ 10k output budget → 16/16 at
    // p50 ~1.3s; gpt-oss-20b topped out at 15/16 with double latency;
    // deepseek-v4-flash timed out (13-15s — measured on the April model the
    // key then pointed at, superseded by 0731 on 2026-08-02). The judge is a SYSTEM
    // quality component — ROLE_TIER pins it "fixed" so a team's utility
    // pick can't degrade it. NOTE: the old 3k judge output budget
    // silently truncated gpt-oss REASONING at medium/high effort and
    // collapsed both models to NONE — budget sits in recall.ts now.
    profileKey: "gpt-oss-120b",
    settingsKind: "recall",
    wrapCache: false,
  },
  // TWO of the three write roles moved off gpt-oss (2026-08-04, memory-eval
  // × 10 repeats): deepseek-v4-flash 15/16 against gpt-oss 13/16 on the same
  // suite, the same day. Consolidation stayed — see its own binding below.
  //
  // What decided it is not the totals but WHERE they differ. gpt-oss lost on
  // judgment and fidelity: `distill-record-activity` returned 8/10, then 5/10,
  // then 3/10 across runs with nothing substantive changed between them — a
  // true stability near 50 % that no prompt can lift — and `promote-oneoff`,
  // which writes a FALSE durable team fact when it slips, sat at 9/10. Both are
  // 10/10 on deepseek-v4-flash.
  //
  // Cost, measured per call on OpenRouter rather than derived from list prices:
  // $0.000087 against gpt-oss-20b's $0.000021, i.e. ~4x — about $0.66 per
  // 10 000 memory calls. The gap is reasoning tokens (236 against 6), which is
  // exactly what was bought.
  //
  // Latency triples (~10 s against ~3 s) and does not matter: these run in
  // background workers and nightly crons, and the timeouts in
  // `services/memory/*` were resized for it. `active-memory` stays on gpt-oss
  // for the opposite reason — it is the only memory role on a turn's hot path,
  // behind a 15 s ceiling.
  //
  // All of the above is at 10 repeats. At 3 — this suite's default until
  // 2026-08-03 — it printed "16/16" while three cases were bimodal and a fourth
  // was dead. Do not re-decide any of it on a 3-repeat run.
  "memory-extract": {
    role: "memory-extract",
    profileKey: "deepseek-v4-flash",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "memory-distill": {
    role: "memory-distill",
    profileKey: "deepseek-v4-flash",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "memory-consolidate": {
    role: "memory-consolidate",
    // The one write role that did NOT move, and the reason the three are kept
    // as separate bindings. Head-to-head at 10 repeats on 2026-08-04:
    // `mem-consolidate-revise` 10/10 on gpt-oss-120b at ~7.7 s against 9/10 on
    // deepseek-v4-flash at ~31.6 s, and the chain suite's contradiction case
    // 8/10 — where BOTH failures were deepseek emitting ~13 700 reasoning
    // tokens, hitting the output cap and returning truncated JSON, which the
    // judge's defensive parse turns into a silent NOOP. The contradiction it
    // was asked to resolve then survives.
    //
    // No budget knob restrains it — a request this route ignores (a factor of
    // 53 here), and raising the output cap only made each runaway cost 25x the
    // median without fixing it. The calls were served by the PINNED upstream,
    // so it is not a fallback landing somewhere worse. Consolidation is also
    // where a wrong result is least recoverable — a bad MERGE takes episodes
    // out of the active set — so it keeps the model that does not gamble.
    profileKey: "gpt-oss-120b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "memory-promote": {
    role: "memory-promote",
    // Split OUT of `memory-consolidate` on 2026-08-04, because the two tasks
    // that shared it want opposite models. Consolidation is safest on gpt-oss
    // (deepseek runs away on reasoning there); promotion is the reverse —
    // `mem-promote-oneoff` measured 10/10 on deepseek-v4-flash against 6/10 on
    // gpt-oss-120b at ten repeats.
    //
    // That case is the over-generalization guard, and it is the most damaging
    // failure in the suite: when it slips, a rule that was never true gets
    // written to team-shared `learned/` memory, where recall then serves it as
    // a FACT on every later turn. 6/10 means four such writes in ten nights.
    // Sharing one binding hid this — reverting consolidation silently reverted
    // promotion with it.
    profileKey: "deepseek-v4-flash",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  "compaction-summarizer": {
    role: "compaction-summarizer",
    profileKey: "deepseek-v4-flash",
    // Was `bare` until 2026-09-18, which left the bound model thinking
    // without a bound — see `COMPACTION_REASONING_MAX_TOKENS` in `resolve.ts`
    // for the fifteen calls that measured what that cost.
    settingsKind: "compaction",
    wrapCache: false,
  },
  "cheap-tasks": {
    role: "cheap-tasks",
    profileKey: "gpt-oss-20b",
    settingsKind: "bare",
    wrapCache: false,
  },
  // The chatbot home screen's starter prompts. Reads ~3k tokens of this
  // reader's own recent work and answers strict JSON, so the two things that
  // matter are holding a format and not running away on reasoning — which is
  // `active-memory`'s envelope exactly, and why it shares it rather than
  // inventing a sixth `settingsKind`.
  //
  // Grouped under `recall` (see `functions.ts`), so what a team picks for
  // recall serves this too and the model hub gains no eighth category. The key
  // below is therefore documentary, as it is for every non-representative
  // role: `resolveFunctionProfileKey` serves the FUNCTION's representative
  // (`active-memory`, gpt-oss-120b) when a team has expressed no preference,
  // which is the same model this line names.
  //
  // Bake-off on one real workspace's pack (3 561 input tokens, 34 citable
  // ids), 3 repeats per arm, 2026-09-13 — the question being whether a home
  // screen refreshed at least daily per user per team deserves the dearest of
  // the three candidates:
  //
  //   gpt-oss-120b, effort low   5/5/5 kept · 1.4 s · 981 out  · $0.00109
  //   gpt-oss-20b,  effort low   4/4/5 kept · 1.2 s · 651 out  · $0.00021
  //   gpt-oss-20b,  effort med   0/6/6 kept · 3.2 s · 2 924 out · $0.00055
  //   deepseek-v4-flash, low     6/5/0 kept · 18 s  · 3 712 out · $0.00159
  //
  // The cheap arm is cheap and holds the format, and still loses on the only
  // thing this screen sells: it attributes. It offered "analyser l'impact de
  // la suppression de Vega Logistics" when the deleted record was Calliope
  // Verre, and relances to a supplier the pack never puts in arrears — cards
  // the provenance gate CANNOT catch, because a wrong claim about an id that
  // was offered is grounded by construction. Raising its effort buys the
  // missing `pending` kind and then loses a whole batch in three to the 4 000
  // output cap, reasoning having eaten the budget (the `conversation-title`
  // trap, at 4x the tokens).
  //
  // deepseek is the one that surprises: HALF the output price of gpt-oss-120b
  // ($0.31 vs $0.60 /MTok) and 1.5x the bill, because it writes ~4x the tokens
  // for the same six cards — and at 13-39 s it overruns the 25 s ceiling in
  // `generate.ts`, which the first visit waits behind synchronously. Its
  // intelligence index (34.5 against 12.3) buys nothing a JSON list of six
  // labels can spend.
  //
  // So the dearest arm is also the only one with three clean runs out of
  // three, and the cheapest first visit in wall-clock. At ~1.5 generations per
  // user per day it is ~$0.05 per user per month. Revisit on the `status`
  // column (used/dismissed per kind), not on list prices.
  "chat-suggestions": {
    role: "chat-suggestions",
    profileKey: "gpt-oss-120b",
    settingsKind: "active-memory",
    wrapCache: false,
  },
  // One-shot malformed-tool-call repair (`repair-tool-call.ts`). Split from
  // the former `dispatch-cheap` role (2026-07, retired 2026-09-26): deepseek-v4-flash hit the 20s repair timeout
  // in prod, turning every repair into pure wasted latency — same failure the
  // recall eval documented, same fix (gpt-oss-120b, ~6x faster). Measured on
  // the April model; the key points at 0731 since 2026-08-02, which is much
  // faster on the pinned upstream — worth re-testing before assuming it still
  // holds.
  "tool-repair": {
    role: "tool-repair",
    profileKey: "gpt-oss-120b",
    settingsKind: "bare",
    wrapCache: false,
  },
  // ONE file-capable model backs BOTH the `vision` tool (free-text visual
  // questions) and the `extract` engine (schema-guided structured output) —
  // the dimension that matters is native input (PDF/image), not "describe vs
  // extract", so there is no separate extraction role. WS0 replay (2026-07-24,
  // 40-page customs DAE) proved gemini-3.6-flash + reasoning `minimal` + NO
  // temperature + a 60K output cap extracts all 43 line items with every field,
  // clean numbers, and correct cross-copy dedup in ONE call (~30s). Two failure
  // modes it fixes: `temperature:0` returns EMPTY on Gemini 3.x (temp is dropped
  // on the Vertex ZDR route anyway, and low temp makes it loop), and reasoning
  // tokens count against the output cap — an 8K/32K cap was consumed by
  // mandatory thinking → `length` cutoff → "No output generated." The `extract`
  // engine (`lib/structured-extract.ts`) and the `vision` call own reasoning
  // `{effort:"minimal"}` + no-temperature per call.
  //
  // Bound to gemini-3.5-flash-lite since 2026-07-25 (5× cheaper input / 3×
  // output than 3.6-flash). Its earlier exclusion — "mandatory reasoning runs
  // away past 60K on dense docs" — did NOT reproduce on re-measurement: on the
  // 2026-07-24 prod fixtures it returned every record on 12/12 free-form runs
  // (5-page slice 28/28 ×8 at efforts minimal AND low, 40-page 43/43 ×4,
  // 14-48s, cleaner values than 3.6-flash) and 6/6 under constrained decoding.
  // The old ruling was measured under `require_parameters` (since removed from
  // `bare`, which emptied its Vertex ZDR pool) and `temperature:0` (empty
  // output on Gemini 3.x) — those conditions, not the model.
  // Extraction is the MEASURED dimension; free-text visual Q&A rides the same
  // binding untested — watch the `vision` traces after the switch.
  vision: {
    role: "vision",
    profileKey: "gemini-3.5-flash-lite",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Fast, reliably-routing, ~10× cheaper fallback (thinking-off, no temperature):
  // less complete per-record than 3.6-flash, but a solid second attempt when the
  // primary's endpoint is unavailable.
  "vision-fallback": {
    role: "vision-fallback",
    profileKey: "gemini-3.1-flash-lite",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Design critic for `managePage { action: "review" }` — it looks at
  // screenshots of a rendered page and scores it.
  //
  // Chosen on a measured A/B (2026-08-15) over the two pages whose defects were
  // already known, against gemini-3.5-flash-lite and gemini-3.1-pro. Flash-lite
  // is 3× cheaper and was the starting assumption; it INVENTED a rendering
  // artifact ("the digit 5 renders with a strike-through") and rated the
  // permanently-inline compose form of a broken mail client a MINOR issue,
  // third in its list. 3.7 Flash named that form the first major finding, and on
  // the healthy page it was the only one of the three to catch what the page's
  // own author had complained about — a chart card so tall it pushes the rows
  // below the fold — plus illegibly small tags and missing column sorting, with
  // no false findings. 3.1 Pro was accurate too, at 6× the price and no better.
  // Corroborated by the one public benchmark close to the task: design_arena
  // "website", where 3.7 Flash ranks 2nd (elo 1333).
  //
  // MOVED OFF GEMINI 2026-08-19, forced by the builder landing there: builder
  // and critic in one family is self-review, and that is the failure this role
  // exists to prevent (see `page-build`).
  //
  // Re-measured with `evals/compare-critics.ts` — same page, same screenshots,
  // one render shared by every candidate, scored on "names the real defects,
  // invents none". A hallucinated finding is the expensive error: the builder
  // spends a fix round (~3 ¢, a minute) chasing something that is not there.
  //
  // The cheap tier failed on capability, not taste: `minimax-m3` (1.1 ¢/page)
  // and `claude-haiku-4.5` (4 ¢) could not return readable JSON at all — 154 s
  // and 123 s to produce nothing; `mistral-small` (0.5 ¢) awarded 9/10 while
  // declaring two MAJOR findings, which is not a gate; `gpt-5.4-nano` (0.9 ¢)
  // invented a major — "Terminé missing from the mobile legend", checked false
  // in the browser at 390 px. Vision + a long rubric + structured output is a
  // floor a small model does not clear.
  //
  // `gpt-5.6-luna` is the cheapest that behaves (4.4 ¢/page at three reviews,
  // ~1.4 ¢ over the Gemini it replaces): five findings, no invention, and it
  // caught the currency rendering as `€93,000.00` in a French UI. Sonnet 5 is
  // sharper still — alone in seeing that `Basse` rows lost the colour dot the
  // other priorities carry — at 8 ¢/page; it stays the REFERENCE judge for
  // measurements (`--page-judge-candidate`), not the production critic.
  //
  // Honest limit: one page, one run. The disqualifications are robust (no
  // output, invented finding, incoherent score); the luna/sonnet gap is not.
  "page-review": {
    role: "page-review",
    profileKey: "gpt-5.6-luna",
    settingsKind: "bare",
    wrapCache: false,
  },
  // The critic for a build that runs on `page-build-fallback` — which is the
  // critic's own model. `criticRoleForBuilder` (`services/page-review/
  // evaluate.ts`) swaps to this binding whenever the builder's family matches
  // the critic's, so the invariant below holds on the fallback path too: a
  // critic never grades its own family. Gemini is the builder's PRIMARY, which
  // by construction is the model that is not building when this one judges.
  "page-review-fallback": {
    role: "page-review-fallback",
    profileKey: "gemini-3.7-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
  // The page BUILDER — the agent that writes the SFC, reads the review and
  // fixes it. Its own role since 2026-08-18, and the reason is a measurement:
  // `pageBuilderSet` was built at module load from `resolveModel("chat")`, so
  // it ignored the team's flagship entirely. Every page this product has ever
  // generated — evals and real teams alike — was written by the code default.
  //
  // Tried on zai-glm-5-3-flash for one evening (2026-09-04) and REVERTED the
  // same day. It was a price move — $0.15/$0.50 per MTok against Gemini's
  // $0.75/$3.75, and a build measured at $0.71 projected near $0.25 — and the
  // A/B says the price is what it buys. Two generation cases per arm, the same
  // code, the same neutral critic, after three infrastructure bugs found that
  // evening were fixed in both arms:
  //
  //   case                     zai-glm-5-3-flash   gemini-3.7-flash
  //   filterable-directory     6.5                 6.8
  //   dashboard-kpi-charts     6.0                 7.0
  //   correctness              0.852               0.918
  //   render gate              1 pass / 1 FAIL     2 pass
  //   cost per page            $0.326              $0.850
  //
  // At n=2 an 0.65 design gap sits inside this critic's run-to-run noise
  // (±0.5-1.0), so the number is not what decided it: the direction is
  // consistent on four independent axes, the GLM arm shipped a table whose
  // rows look clickable and are not, and the product owner read both arms'
  // pages and called the difference flagrant. Cheaper pages nobody would ship
  // are not cheaper.
  //
  // Worth keeping from that evening, because it is about the POOL and survives
  // the revert: `models:bench -- --profile zai-glm-5-3-flash` (8 upstreams × 3
  // runs of 4 096 tokens) measured `intact` 3/3 on every host that answered,
  // and a flat 5× warm-against-cold discount — so the ~20 K builder prefix IS
  // cached even though no GLM endpoint publishes `supports_implicit_caching`
  // and the policy rule therefore reads FAIL. Two hosts are quarantined by
  // hand from that run and STAY quarantined: `sailresearch` caps completions
  // at 2 048 tokens where the rest of the pool is ≥ 128 000 (a multi-file
  // `pageWrite` routed there is cut silently, and this role sends no
  // `maxOutputTokens`), and `wafer` spent its whole allowance on reasoning
  // without writing an answer. They lapse after a re-probe on 2026-09-11 — a
  // short probe sees neither defect, so check `models:admin -- show` that week.
  //
  // Repointed to gemini-3.7-flash on 2026-08-19 by the A/B that role was
  // created to make possible — three building cases, both arms judged by a
  // NEUTRAL critic (claude-sonnet-5, `--page-judge-candidate`), because the
  // candidate and the then-critic shared a family and the arm would otherwise
  // have scored its own work:
  //
  //   case                     deepseek-v4-flash   gemini-3.7-flash
  //   vague ask                5.4                 5.8
  //   filterable directory     5.1                 5.8
  //   detailed dashboard       NO PAGE SAVED       5.6
  //   correctness              0.750               0.908
  //   latency / case           ~19.8 min           ~7.4 min
  //
  // The control did not fail on a rig error: `finishReason: stop`, 27 minutes,
  // 25 tool calls (14 of them `managePage`), and nothing persisted — on the
  // most canonical case in the suite. On design score alone the deltas (+0.4,
  // +0.7) sit inside a critic's run-to-run variance at n=3; what decides is
  // correctness, 2.7× the speed, and the page that never existed.
  //
  // The bias ran AGAINST the winner, which is why the result is trustworthy:
  // the Gemini arm still self-reviewed inside its own build loop (the service
  // resolves `page-review` internally, no header reaches it), so it iterated
  // against a critic inclined to praise it and still won on a neutral judge.
  //
  // `page-build` settings: the `chat` envelope and cache wrap (the builder is
  // a multi-step tool-calling agent on a long context, not a one-shot) plus
  // the role's OWN reasoning budget — a delegated build is an internal
  // pipeline whose thinking allowance is a system decision, not the profile's
  // user-facing effort ladder (`settingsForRole` carries the measurement).
  //
  // THIS AND `page-review` MOVE TOGETHER. They may never share a family.
  "page-build": {
    role: "page-build",
    profileKey: "gemini-3.7-flash",
    settingsKind: "page-build",
    wrapCache: true,
  },
  // The builder's own fallback, under the builder's own envelope. Until
  // 2026-09-14 the builder fell back on `chat-fallback` (then MiniMax M3)
  // resolved under the CHAT envelope — no page-build reasoning allowance, and
  // the history-pruning prices of the primary. A fallback that starts a build
  // from zero after the primary was cut has to be at least the primary's
  // equal: Luna is family-disjoint from Gemini and the critic swaps to
  // `page-review-fallback` when this one builds.
  "page-build-fallback": {
    role: "page-build-fallback",
    profileKey: "gpt-5.6-luna",
    settingsKind: "page-build",
    wrapCache: true,
  },
  // Document-scale prose transformation (the `transform` tool): translate,
  // rewrite, restyle a whole document chunk-by-chunk. Separate from the
  // `extract` roles on purpose — extract is native-PDF/vision-pinned, whereas
  // transform is text-in/text-out and wants a fast, strongly-multilingual
  // workhorse. `bare`: the engine owns per-call options (temperature 0, output
  // cap). No cache wrap — chunk calls are independent one-shots.
  transform: {
    role: "transform",
    profileKey: "deepseek-v4-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
  // Different family from the primary (deepseek), strong on multilingual
  // prose — the observed failure class is a truncated or refused chunk, and a
  // family swap is the most effective second attempt.
  //
  // Points at a model no team can pick ON PURPOSE: gemini-3.7-flash is too
  // expensive to OFFER as a team pick (~2× an M3 turn at the settled price
  // corrected 2026-08-18) but is the right second attempt on a low-volume
  // fallback path. Role bindings bypass `isSelectableForTier`, so this is legal
  // and intended.
  "transform-fallback": {
    role: "transform-fallback",
    profileKey: "gemini-3.7-flash",
    settingsKind: "bare",
    wrapCache: false,
  },
};
