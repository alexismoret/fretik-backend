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
  // Gated flip 2026-08-02 (run 8e3ea13a8b4b3968): minimax-m3 → deepseek-v4-flash.
  // Faster (56.3s → 30.8s avg), ~2.9× cheaper per turn, ahead on reasoning and
  // tool-use. The displaced M3 becomes `chat-fallback` below, which keeps
  // primary and fallback on different families and different upstreams.
  // KNOWN REGRESSION in that run, accepted with eyes open: EXTRACTION. The gate
  // read 0.964 → 0.821; two dedicated `--capability extraction` runs then
  // measured 0.869 twice, byte-identical (pass-rate 0.714, 0 fallbacks). So it
  // is NOT judge noise on this subset — it is a real, reproducible ~0.1 gap
  // against M3, worth ~0.67 case-equivalents, inside the ≤1 threshold but on a
  // capability central to this product. It is the price of the switch, not a
  // measurement artefact: revisit it if extraction complaints appear, and
  // re-check it first when this binding is next gated. generation 1.000→0.933
  // and instruction-following 1.000→0.944 are the other two, both in threshold.
  chat: {
    role: "chat",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
    evalGate: {
      status: "passed",
      lastRunId: "8e3ea13a8b4b3968",
      gatedAt: "2026-08-02",
    },
  },
  // Deliberately a DIFFERENT family and a different upstream from `chat`:
  // this binding exists for the turns where the primary died, so sharing
  // DeepSeek's weights or DeepInfra's capacity with it would let one incident
  // take out both. minimax-m3 was the gate-passing default until 2026-08-02 and
  // routes via Novita.
  "chat-fallback": {
    role: "chat-fallback",
    profileKey: "minimax-m3",
    settingsKind: "chat",
    wrapCache: true,
    // Its own C3 run, from when it held `chat`: all capabilities at or above
    // the M2.7 baseline, $0.0134/turn. The avg-latency criterion passed only
    // after the 1.5× recalibration (the 1.3× cap was below measured same-model
    // variance); the earlier ccf1822e attempt failed on an empty ZDR pool, not
    // on the model. Kept because a fallback still serves real turns.
    evalGate: {
      status: "passed",
      lastRunId: "3aeec9d1-583f-4ac2-b35a-6cc1381665f3",
      gatedAt: "2026-06-12",
    },
  },
  // Autonomous workflow executor. Defaults to the SAME profile as `chat`
  // (reliability first — the priority order is precision > cost) and follows
  // the team's flagship tier pick; a workflow may override per-run via its
  // `modelProfileKey`. The agent already delegates mechanical sub-tasks to the
  // cheap model via `dispatchAgent`, so the default need not be the cheap one.
  // Tracks `chat` (reliability first) — flipped in the same gated change.
  workflow: {
    role: "workflow",
    profileKey: "deepseek-v4-flash",
    settingsKind: "chat",
    wrapCache: true,
    evalGate: {
      status: "passed",
      lastRunId: "8e3ea13a8b4b3968",
      gatedAt: "2026-08-02",
    },
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
    settingsKind: "bare",
    wrapCache: false,
  },
  "cheap-tasks": {
    role: "cheap-tasks",
    profileKey: "gpt-oss-20b",
    settingsKind: "bare",
    wrapCache: false,
  },
  // One-shot malformed-tool-call repair (`repair-tool-call.ts`). Split from
  // `dispatch-cheap` (2026-07): deepseek-v4-flash hit the 20s repair timeout
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
  // The page BUILDER — the agent that writes the SFC, reads the review and
  // fixes it. Its own role since 2026-08-18, and the reason is a measurement:
  // `pageBuilderSet` was built at module load from `resolveModel("chat")`, so
  // it ignored the team's flagship entirely. Every page this product has ever
  // generated — evals and real teams alike — was written by the code default.
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
