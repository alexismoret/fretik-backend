# Evals runbook — how to check evals & what to run when

The chatbot eval is **one engine** (this `evals/` harness, runs the REAL chatbot
end-to-end) invoked from **three surfaces**, each with a distinct job.

| Surface           | Who / when                   | Job                                                                                                          |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Scripts (dev)** | You, by hand, after a change | "Did my change help?" — run the cases against your dev service, score, push a dataset-run. THE only surface. |
| **Langfuse UI**   | You, to analyse              | Compare dataset-runs, read per-capability scores, drill into a failing trace. NOT a runner for offline evals |

Separately: the **managed online evaluator** (configured in the Langfuse UI) runs
continuously on **prod** traffic, sampled — quality monitoring, not the dataset loop.

**Why evals are NOT in CI at all.** The curated cases drive a LIVE `@fretik/ai` AND
assume the target team's real data (counts, documents, entities), so they cannot run
against a fresh CI database; a runner cannot reach your dev machine; and evaluating a
PR against an _external_ deployed service would test the deployed code, not the PR.
There is no combination of those that a runner can satisfy, which is why the manual
`langfuse-experiment.yml` workflow was deleted on 2026-09-02 — it had never been able
to run (every step pointed at a `backend/` directory that does not exist inside its own
repo), and nothing was lost with it: the engine is `bun run evals:gate`, right here.

PR quality gating — typecheck / lint / unit / integration / image build — lives in
`.github/workflows/backend.yml`. Run evals locally against dev before merging (below),
never against prod: eval turns spend on the prod account and emit `env=production`
traces that pollute prod analytics.

## Day-to-day (scripts)

Needs a **live `@fretik/ai` service** and `AI_SERVICE_URL` (it is NOT in `.env` — pass it inline):

```bash
cd backend/packages/ai
# 1. start the service in another pane (dev DB): bun run dev   (or ../../dev.sh)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse                 # CORE baseline (~45 cases)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --all        # + model-gate probes (~72, model promotions / deep re-baseline)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --smoke      # smoke subset (~17, both tiers)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --capability external-actions
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --deterministic-only   # no judge (free of judge cost)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --run-name <name>      # explicit dataset-run name
```

`.env` needs the usual `EVAL_TEAM_ID` / `EVAL_ORGANIZATION_ID` / `EVAL_USER_ID`,
plus **`EVAL_OTHER_USER_ID`** — a SECOND real member of the same organization,
used only by `mr-private-leak`. Without it that one case throws
`Missing eval env var: EVAL_OTHER_USER_ID`, deliberately: the alternative is a
privacy case that silently tests nothing (see the `memory-recall` section).

**Keep the output in a file — the per-item report is long and the earliest cases scroll away
first.** Three runs in a row were read with items 1-6 already gone, which is precisely where a
case that never ran leaves its only trace:

```bash
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --suite pages 2>&1 | tee /tmp/eval-run.log
```

A run whose item COUNT is short of the suite is the failure to look for first: the summary
reports the average over the cases that finished, so a case dropped mid-flight lowers nothing
and shows up only as a smaller `N items`.

**The pages suite needs a browser.** TEN of its thirteen cases RENDER the page the turn stored,
in the eval process, via `evals/page-design-judge.ts`: every case that builds one
(`page-dashboard-kpi-charts`, `page-filterable-directory`, `page-vague-request-expands`,
`page-multi-source-gate`, `page-giga-multi-view`, `page-bulk-and-link-writes`,
`page-thread-shape`, `page-console-shape`, `page-time-shape`,
`page-from-uploaded-file`). The
mechanical gate and a design score are the only assertions that see what a user sees. (This
line said "three" until 2026-08-18 and "nine of twelve" until 2026-08-22 — it has understated
the rig every time a case was added, so re-count it from `rendersAndWorks` in
`evals/cases/pages.ts` rather than trusting the sentence.) That needs the same two
things the `review` action needs — a Chrome/Chromium on `$PATH` (or `PAGE_RENDER_BROWSER_WS` pointing at a
browserless sidecar) and the page-runtime assets (`PAGE_RUNTIME_DIR`, or `APP_URL` to fetch
them). On macOS an installed `/Applications/Google Chrome.app` is found without any `$PATH`
entry and is PREFERRED over WKWebView (`render/webview.ts`). When no browser is reachable
those assertions FAIL rather than pass quietly, and say `renderer unavailable` — that phrase
means the rig, never the page.

**What a judged case costs, and what changed it (2026-08-21).** The old figure — ~20s and
~2¢ per case — predates three additions, and two of them are not free:
a `desktop-mid` capture on any page taller than 2.5 screens (one more IMAGE for the critic,
the expensive kind of token), the overlay structure snapshots (text, and cheap — measured at
**201 characters for a full detail panel**, against ~1 000 tokens for the equivalent picture),
and one more page family in the suite. **Re-measure before quoting a number**: read
`cost-per-turn-usd` off the last full run in the Langfuse UI rather than trusting this
paragraph, because the giga case alone renders a page several screens deep and is the most
expensive item in the suite by construction.

**Build cases are bounded by their CLOCK, not by their tool calls.** `maxToolCalls` cannot see
a delegated build — `buildPage` runs its own loop inside one tool execution and streams
nothing, so a page built the recommended way counts as one call however many steps it took.
Every case that builds a page therefore carries `{ type: "latencyUnder", ms: 180_000 }`
(240 000 for the giga case, which is a skeleton plus one edit per section by design). Cost
stays a RUN-level score: `cost-agent-usd` / `cost-per-turn-usd` / `cost-per-page-usd`, from the
server's own per-step ledger (see `## Cost`). Per-case cost as an ASSERTION would still be a bad
trade — a threshold on one build's price fails on a case that legitimately needed a sixth review
round — but the number itself now rides on every turn, in `TaskOutput.spend`.

**Model pinning.** Every `evals:langfuse` run pins the turn model via
`X-Model-Profile-Key` — default = the CODE `chat` binding in
`src/lib/model-registry/role-bindings.ts` (the flagship held to 1.000), overridden by
`--candidate <profileKey>`. Without the pin, the EVAL team's C8 picker choice
silently overrides the code binding (the 2026-07-17 runs measured `gpt-oss-20b`
that way). The `evals:memory` / `evals:recall` / `evals:chain` harnesses are
separate: they run the services IN-PROCESS and take their model from the code
bindings, overridable with `--profile` / `--judge-profile`.

**Pinning the PAGE BUILDER is a second, separate knob.** `--candidate` reaches the
parent turn only. Pages are written by a delegate on the `page-build` binding, so
a run pinned with `--candidate` alone measures the model that DECIDES to build a
page while the one that writes it stays on the code default — which is what every
page measurement did before 2026-08-18, when the builder was frozen at module load
and no pin could reach it at all. Use `--page-build-candidate <profileKey>`
(header `X-Page-Build-Profile-Key`, `/invoke` only, unknown keys 400):

```bash
# control, then a candidate builder — same cases, same parent model, NEUTRAL judge
CASES="--case page-vague-request-expands --case page-dashboard-kpi-charts --case page-filterable-directory --case page-time-shape"
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- $CASES --page-build-candidate deepseek-v4-flash --page-judge-candidate claude-sonnet-5 --run-name ab-build-control | tee /tmp/control.log
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- $CASES --page-build-candidate gemini-3.7-flash  --page-judge-candidate claude-sonnet-5 --run-name ab-build-gemini  | tee /tmp/gemini.log
```

The run metadata records `pageBuildProfileKey`, so a run says which model wrote its
pages, not just which one decided to. **Compare the DESIGN AVERAGE across the
building cases** — correctness moves for many reasons, the design score is what a
builder swap is for.

**`--page-judge-candidate` is not optional when an arm straddles the critic's
family.** The two bindings are kept in different families on purpose — today
`page-build` is `gemini-3.7-flash` and `page-review` is `gpt-5.6-luna` — so the
default pairing is already neutral. Pin a builder from the CRITIC's family and
that arm scores its own family's work; repoint the judge for that arm. Unlike
the builder pin (a header on the service call), the critic runs in THIS process,
so the flag travels by `EVAL_PAGE_JUDGE_PROFILE` to `evals/page-design-judge.ts`.
A neutral judge costs ~2.7 ¢ per page on `claude-sonnet-5` — noise against a
~11 ¢ build, and it is the only reason to trust a cross-family comparison.

One caveat the flag does NOT cover: the builder's OWN review loop runs inside the
service on the `page-review` binding. An arm pinned to the critic's family
therefore self-reviews while building, which biases it DOWNWARD on a neutral
judge (a critic that praises its own family catches less) — a win under those
conditions is trustworthy; a loss is not conclusive.

**`--case <id>` (repeatable)** narrows any selection to the cases that
discriminate. An A/B pays for every arm, so buy the four cases that move the
design score rather than the whole suite: the vague ask (design initiative), the
detailed dashboard (faithful execution), the directory (dense data), and one
non-dashboard shape (does everything collapse into a dashboard?).

**The memory harnesses, in one table.** All three share the EVAL team, so the
fixtures of one decide cases in another — clean up before switching.

|                | What it scores                                                                      | Needs the AI service | Repeats |
| -------------- | ----------------------------------------------------------------------------------- | -------------------- | ------- |
| `evals:memory` | each generator in isolation                                                         | no                   | **10**  |
| `evals:recall` | the `<active_memory>` block                                                         | no                   | **10**  |
| `evals:chain`  | conversation → distill → consolidate → promote → recall, with per-stage attribution | **yes**              | **10**  |

- **`evals:chain` requires `bun run dev` in this package.** Writing a memory
  triggers its indexing over HTTP (`callAiService("/internal/vectorize")`,
  because `@fretik/shared` cannot import `@fretik/ai`), the call is
  fire-and-forget, and its errors are swallowed by design. With no listener the
  promoted memory is simply never indexed, recall cannot retrieve it, and the
  suite reports a chain failure that is really "no dev server was running"
  (measured 2026-08-04: 0/5, zero vectors, 20 s of waiting included).
- **Ten repeats, not three.** Until 2026-08-03 the memory suite defaulted to 3
  and printed "16/16"; at 10 the same code was 12/16 — three bimodal cases and
  one dead. Three repeats cannot separate a 58 % case from a 100 % one, so a
  3-repeat number is not evidence for or against anything.
- **Isolation:** `evals:memory -- --cleanup` and `evals:chain -- --cleanup`
  before any `evals:recall` run — their supplier fixtures otherwise contaminate
  `rec-volume-selectivity` and the NONE cases.
- **Closure rule for a contested case.** Stable-at-N=10 cannot separate ~93 %
  from ~99 % — a case flagged `BIMODAL` is decided by a targeted run
  (`--case <id> --repeats 30`) and counts as CLOSED at **≥ 29/30**. Never
  arbitrate two whole-suite totals against each other; only paired, per-case
  numbers decide anything (the 2026-08-04 "15/16 vs 13/16" was pure draw
  noise — the bimodal set permuted between runs while the code barely moved).
- **A chain number before 2026-09-09 is not a number.** None of the three
  runners warmed the model registry, so recall threw `No model profile for key
"gpt-oss-120b"`, swallowed it by design, and returned NONE — every
  recall-side assertion in every suite failed for a reason that had nothing to
  do with the code under test. Fixed in `0d8a7f5`. Do not compare against a
  chain score recorded before it.
- **Chain, last measured 2026-09-10** (10 repeats, isolated): 3/4 fully
  stable — `decision-survives`, `convention-promoted` and `oneoff-not-durable`
  at 10/10, `contradiction-corrected` at 9/10 whose single failure is a
  provider timeout rather than a recall miss. Zero recall misses across all
  40 repeats.

### `RECALL_MODE` — measured 2026-09-09, `adaptive` is the default

| mode       | score (10 repeats) | judge runs on | recall p50   |
| ---------- | ------------------ | ------------- | ------------ |
| `adaptive` | **23/23**          | 43 % of turns | **1 398 ms** |
| `judge`    | 23/23              | 100 %         | 2 246 ms     |
| `verbatim` | 17/23              | never         | 1 417 ms     |

Parity with the judge at 62 % of its latency. What the six `verbatim` failures
were, and how they went away:

- **Four were abstention** — refusing a candidate that scores well but does not
  answer the message. No score threshold decides this: over 230 repeats the
  must-abstain cases span 0.200-0.844 and the must-cite cases 0.364-0.995, and
  `rec-abstention-insufficient` must abstain at exactly 0.364 while must-cite
  cases sit there too. A threshold cannot decide it, but it can SORT — that is
  `JUDGE_ESCALATION_BEST_SCORE`, and routing the weak-gather turns to the judge
  recovers all four.
- **One was a scoring bug.** `bestScore` counted documents, which are not
  rendered, so a lexically dominant invoice made `rec-noise-general` oscillate
  0.33 ↔ 0.90 across identical repeats and abstention became a coin flip.
  Knowledge-only made it a stable 0.252.
- **One was the document axis, and it was measured rather than assumed.**
  Documents admitted freely: 21/23 (they buy `rec-document-content` and cost
  `rec-multi-domain`, whose record is pushed out of the shared 2 000-char
  budget, plus `rec-graph-link` flapping at 9/10). Excluded entirely: 22/23.
  Admitted only when a document TOPS the ranking (`DOCUMENT_TOP_MARGIN`, the
  same positional shape as the capability channel): **23/23**.

`judge` is the rollback — one env var, no deploy, previous behaviour exactly.

### The candidate budget is spent, not rationed (2026-09-10)

The per-candidate ceiling used to be one number — the 2 000-char block divided
in advance across a worst-case eight candidates — charged on every turn
including the ones that selected two. Measured over 230 recall repeats, **220
(96 %) clipped at least one candidate**, most of them while well under the cap.

A clip is not a neutral loss: it keeps the opening and drops the conclusion,
and a summary that RESOLVES something puts the resolution last. That is a
wrong answer, not a lossy one — see `chain-contradiction-corrected` below.

It is now a descending ladder (`700 → 200`), and the block takes the largest
rung that fits. `HARD_BLOCK_CHAR_CAP` is unchanged, so this spends room already
reserved rather than asking for more: recall stayed **23/23**, escalation
stayed at **43.5 %** (100/230 — no latency cost), and turns keeping every
candidate whole went **10/230 → 81/230**.

Escalating clipped turns to the judge was the other candidate, and the
measurement killed it: at a 96 % clip rate that rule routes nearly every turn,
which is worse than `judge` mode with the latency win gone. **Read the
`clipped=` field on the per-turn line before proposing a rule keyed on it.**

### Retrieval-arm attribution (2026-09-10)

`searchRAG` emits one `[search]` line per call and `hybridSearch` one
`[hybrid]` line, so a slow arm names a suspect rather than a stage. First
measurement, 690 calls over a 23 × 10 recall run:

| stage    | p50    | p90    | max    |
| -------- | ------ | ------ | ------ |
| `embed`  | 2 ms   | 4 ms   | 17 ms  |
| `hybrid` | 324 ms | 499 ms | 810 ms |
| `rerank` | 304 ms | 422 ms | 982 ms |

Postgres and the cross-encoder are the arm, in that order, and they are
sequential. **The embedding figure is the Redis cache-hit path** — the eval
runs each query ten times — so it is not what a genuinely novel query pays;
do not quote it as "embedding is free" without a cold-cache measurement.

`hybridSearch` splits its own line further. The three arms run on separate
connections, so the stage costs `max(arm)`, and it is always the same arm:

    [hybrid] semantic=673 bm25=189 registry=186

### OPEN: the HNSW index is never used (found 2026-09-10, NOT fixed)

**Every broad semantic search is an exact brute-force scan.** Measured against
dev (20 504 vectors, pgvector 0.8.2, PG 17.10), on the real query shape with
the real scope predicate:

| plan                          | rows returned | exec time  |
| ----------------------------- | ------------- | ---------- |
| what runs today (Seq Scan)    | 150           | 260-385 ms |
| forced index, `ef_search=400` | 150           | 6 ms       |

The index is present, valid, 167 MB, `halfvec_cosine_ops` — and the planner
prices it at **97 730 against the Seq Scan's 3 310**, a ~30× overestimate, so
it never picks it. Nothing is broken in the sense of wrong answers: brute force
is EXACT KNN, which is part of why recall scores 23/23. It is the latency that
is wrong, and it grows linearly with the corpus — this table is 20 k rows.

**Do not "fix" this with a planner hint.** Three attempts, all measured, all
worse than they look:

- `SET LOCAL enable_seqscan = off` alone: on the knowledge arm
  (`source_type IN ('memories','episodes','records')`) the HNSW scan returned
  **8 rows instead of 150**. Filtered HNSW stops after `ef_search` candidates,
  so a hint that looks like a 40× win silently guts the candidate pool.
- `hnsw.iterative_scan = relaxed_order` on top: the planner abandoned HNSW
  altogether for a bitmap scan on `idx_ai_vectors_organization_id`, 219 ms.
- Raising `ef_search` (150 / 400 / 800) changes how many rows come back
  (73 / 150 / 150) but never changes the plan CHOICE — the cost model is the
  blocker, not the tuning.

The selective arms are already fine and must stay that way: `documents`
(118 rows) uses `idx_ai_vectors_source`, exact, 2.4 ms, and is unaffected by
any of the above.

Whatever the fix turns out to be — partial HNSW indexes per `source_type`,
statistics work on `ai_vectors` (`last_analyze` is empty; only autoanalyze has
ever run), or restructuring the OR-shaped scope predicate — it changes
retrieval, so it is settled by `evals:recall` at 10 repeats holding **23/23**
and not by the EXPLAIN alone.

### Running the A-B

Re-run all three whenever the selector, the floors, or the escalation
threshold move. Ten repeats, same fixtures, and compare **per case** — never
two totals against each other (the closure rule above applies unchanged):

```bash
bun run evals:memory -- --cleanup && bun run evals:chain -- --cleanup
bun run evals:recall -- --repeats 10 --mode adaptive   # the default
bun run evals:recall -- --repeats 10 --mode judge      # the rollback path
bun run evals:recall -- --repeats 10 --mode verbatim   # the no-LLM floor
```

`--mode` replaced `RECALL_MODE=` on this suite, because the env var is read
**once at module load** — a run that set it could not say so in its own
results, and two runs in different modes were compared in the Langfuse UI as
though they were comparable. The mode now travels with the call and lands in
the run metadata. `RECALL_MODE` still works as the process default (a service
restart, not "the next turn").

Two other flags change what a run is a measurement OF, and both land in the
metadata for the same reason:

- `--prefetch` — start the gather, let it run under a simulated 300 ms prelude,
  then collect it. That is the topology `/stream` actually has, so `gatherMs`
  becomes the WAIT a turn pays rather than the un-overlapped cost. Without it
  the suite overstates the turn's latency and cannot see whether a change moved
  the wait at all.
- `--scale N` — top the EVAL team's `ai_vectors` up to N synthetic distractors
  before running, so "fast enough" is a claim about a SIZE. ~250 MB at 50 000.
  `--cleanup-scale` drops the volume and keeps the universe runnable;
  `--cleanup` drops both.

  The distractors are REAL vectors perturbed by gaussian noise (σ=0.02) and
  renormalised, and that σ is load-bearing in both directions: the corpus's own
  spread is cosine 0.42-0.88 between real documents, σ=0.02 lands a distractor
  at 0.70 — inside it. Larger (≥0.05, cos<0.4) makes them near-orthogonal noise
  that any index separates trivially, so a scale run reports a healthy semantic
  arm however broken it is; smaller (≤0.005, cos>0.97) makes them
  near-duplicates that outrank the fixtures, so the run fails its ASSERTIONS
  and reads as a recall regression instead of a corpus seeded wrong.
  `tests/unit/evals/scale-vectors.test.ts` pins both edges.

Every turn logs the routing decision, so a threshold is recalibrated from a
distribution rather than argued about:

```
[recall] mode=adaptive escalate=true best=0.252 uncorroboratedAnchors=0 nearTies=1 greyZone=false chars=0
```

To recalibrate `JUDGE_ESCALATION_BEST_SCORE`, group `best` by whether the case
must cite or must abstain and look for a threshold that routes every
must-abstain repeat. There is none that also spares the must-cite ones — the
distributions overlap — so the number is chosen where the routed fraction is
flat (0.50 → 0.65 route identically) rather than at a cliff, and 0.70 is the
first value that catches every abstention case.

### `memory-recall` — the same question, asked of the ANSWER (added 2026-09-10)

`evals:recall` grades the memory BLOCK: which ids the selector rendered. That
is the right instrument for TUNING the selector and the wrong one for deciding
whether to KEEP it — a block that cites the right ids and an answer that uses
them are two different claims, and only the second is what a user experiences.
Taking the judge off the critical path is a bet about what the MAIN model does
with the same candidates unfiltered, so no block score can settle it.

12 cases (`evals/cases/memory-recall.ts`), through the real turn, over the SAME
fixture universe as the block suite so the two read against each other:

```bash
bun run evals:memory -- --cleanup && bun run evals:chain -- --cleanup
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- \
  --suite memory-recall --repeats 10 --recall-mode judge --run-name mr-judge
# …same with --recall-mode adaptive, then verbatim. Compare PER CASE.
```

Four cases are must-NOT checks and they are the ones the Phase 5 judge-removal
gate turns on: `mr-abstain-general`, `mr-greeting`, `mr-private-leak`,
`mr-homonym`.

**`mr-private-leak` needs `EVAL_OTHER_USER_ID`** — a second real member of the
eval organization — and it is worth knowing why, because the case was written
wrong first and could not fail. Running it in system scope (no
`X-Context-User-Id`, the way the block-level `rec-privacy-hidden` does) does not
put the turn in "no owner" mode: `buildTurnCallOptions` gates the entire recall
branch on a caller id, so a userless turn gets **no memory block at all** and
every must-NOT assertion passes for the wrong reason, identically in all three
arms. The privacy axis needs another PERSON, not no person.

Two lessons from fixing it, both general:

- **A must-NOT case needs a positive control.** "The private figure is absent"
  is trivially true of an answer that retrieved nothing. The case now also
  requires the team-visible `4 200 €` rent, so the negative only counts when
  retrieval demonstrably ran.
- **A marker the answer can produce on its own is not evidence.** The private
  note's tactics were checked too; `taux de vacance` fired 3 times in 20 repeats
  and every one came from `searchWeb` quoting a commercial-property report.
  Vacancy rates are ordinary lease vocabulary. That check was a random-failure
  generator on a guardrail case and was removed; the internal ceiling
  (`4 500 €/mois`, which appears nowhere else) is the only marker kept.

Measured after the fix: the ceiling leaks **0/10 in both arms**, so the scoping
holds through the pre-turn block AND through `searchKnowledge`, which applies
the same `user_id IS NULL OR user_id = :caller` clause.

The case's prompt is also a QUESTION rather than the task the block-level twin
uses, and that too is a measurement: "Prépare la renégociation…" ran **116-1130 s
per turn on ~30 tool calls** — the agent building a full negotiation package with
bash, python, vision and presentFiles. Defensible behaviour, complete noise
around a privacy assertion, and ten repeats of it cost more than the other
eleven cases combined. Asking the question instead: **33-98 s and 3-5 tool
calls**, about a tenth of the cost, and the case went to 10/10 in both arms —
the one adaptive failure under the task wording was the positive control not
firing amid thirty tool calls, not a scoping problem.

Baseline after the rewrite (10 repeats each, `mr-leak2-*`):

| arm        |  pass | `4 500` leaked | `4 200` control | latency p50 |
| ---------- | ----: | -------------: | --------------: | ----------: |
| `judge`    | 10/10 |           0/10 |           10/10 |        58 s |
| `adaptive` | 10/10 |           0/10 |           10/10 |        62 s |

**`ttft-p50-ms` is not readable at the default concurrency.** Measured
2026-09-10: `mr-private-leak` and `mr-memory-convention` reported 22 s TTFT at
`--concurrency 3` and **0.9-2.2 s** at `--concurrency 1` — same cases, same
service, same commit. The queue, not the pre-turn. `correctness` does not care;
anything time-shaped does. Every dataset run now records `maxConcurrency` in
its metadata, so the number cannot be read without it — take the TTFT baseline
at `--concurrency 1` and the correctness baseline wherever you like.

#### Baseline — 2026-09-10, 12 cases × 10 repeats, paired (`mr-baseline-*`)

`--concurrency 3`, `chat` = deepseek-v4-flash, recall judge = gpt-oss-120b.
Compared per case, which is the only comparison this table supports:

| case                       |    judge |  adaptive |      Δ | judge pass | adaptive pass |
| -------------------------- | -------: | --------: | -----: | ---------: | ------------: |
| `mr-episode-decision`      |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-right-episode`         |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-graph-link`            |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-contradiction-current` |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-document-top`          |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-badly-written`         |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-greeting`              |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-homonym`               |    1.000 |     1.000 |      — |      10/10 |         10/10 |
| `mr-memory-convention`     |    0.950 |     1.000 | +0.050 |       9/10 |         10/10 |
| `mr-abstain-general`       |    0.975 |     0.950 | −0.025 |       9/10 |          8/10 |
| **`mr-broad`**             |    0.975 | **0.900** | −0.075 |       9/10 |      **6/10** |
| overall                    |    0.986 |     0.985 | −0.001 |      0.958 |         0.942 |
| TTFT p50                   | 3 069 ms |  2 205 ms |  −28 % |            |               |
| turn latency p50           |   36.4 s |    22.7 s |  −38 % |            |               |

Cost was the same either way — $0.006/turn, $0.68 per 120-turn arm.

**Read the two failing cases, not the totals.** Every retrieval-shaped case is
10/10 in both arms: the right episode among four on one record, the graph-only
link, the superseded value, the document-only figure, the misspelled query. The
judge is not buying retrieval quality. What it buys is a little robustness on
**synthesis** (`mr-broad`, 9/10 → 6/10) and **abstention** (`mr-abstain-general`,
9/10 → 8/10) — the two open-ended shapes — for +864 ms of TTFT and +14 s of turn.
`mr-broad` is the case Phase 4's confidence bands have to move; it is now a
target with a number on it rather than a hypothesis.

`mr-private-leak` is excluded from this table — it was rewritten after the run
(see below) and its baseline was taken separately.

**Two things keep N repeats from collapsing into one measurement, and both are
easy to break by accident.** `runUnifiedRecall` memoises a gather for 15 s per
`(team, user, mode, message)`, so:

- `--recall-mode <mode>` also sets `bypassCache` on the call, which is why an
  A/B arm re-gathers every repeat. A `memory-recall` run WITHOUT the flag does
  not, and is worth less than it looks.
- repeats are ordered **pass-major** (`[all cases pass 1, all cases pass 2, …]`,
  `evals/langfuse/experiment.ts`), so two repeats of one case are a dozen turns
  apart. Reordering that to case-major — which looks tidier — would put them
  inside the 15 s window and silently turn ten samples into one plus nine cache
  hits.

**Frozen baselines — 2026-08-05** (`freeze-*` / `n30-*` runs, code bindings:
extract/distill/promote = deepseek-v4-flash, consolidate + recall judge =
gpt-oss-120b):

| Suite                     | Frozen               | Detail                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `evals:memory` (17 cases) | 16/17 stable at N=10 | flagged `mem-relation-noise` 9/10 re-ran **30/30** → closed. The four once-contested cases, targeted: reanchor 30/30 · merge 30/30 · revise 29/30 · distill-record-activity 30/30                                                                                              |
| `evals:chain` (4 cases)   | **4/4** at N=10      | `chain-contradiction-corrected` closed by the consolidation-judge id handles                                                                                                                                                                                                   |
| `evals:recall` (23 cases) | 22/23 stable at N=10 | **open residual**: `rec-noise-general` — 8/10 in the freeze, **14/30** targeted (historic ~88 %). Judge-side selectivity against a lexically dominant, non-responsive candidate; the hot-path judge model is deliberately out of scope here. The one case of 44 below the bar. |

**Run tiers.** Every curated case is either **core** (behavioral regression — the
prompt/tool/harness signal, runs on every full baseline) or **`tier: "model-gate"`**
(per-MODEL probes: BFCL-style tool mechanics, IFEval validators, long-context,
native multimodal — they measure the model, not the prose, and are the slow half
of the suite). The default `evals:langfuse` runs core only; `--all` and every
`evals:gate` promotion run include both. `--smoke` / `--capability` select
explicitly across both tiers. Changing a prompt or tool description → core run.
Changing a model binding → the gate (which is always full).

The run prints a per-capability summary + a **dataset-run URL** → open it in Langfuse to
compare against previous runs. The baseline = a frozen dataset-run; a change is good when
its run beats the baseline with no per-capability regression.

## When you continue an implementation

1. Make your change.
2. `evals:langfuse -- --smoke` for a fast check (or `--capability X` for the area you touched).
3. Read the dataset-run in the UI vs the last baseline. Regression on a capability → investigate the failing case (drill into its trace).
4. When happy, run the full `evals:langfuse` to refresh the baseline.

## One-time / occasional setup

```bash
bun run langfuse:triage-cases       # Gemini scores each case keep/rewrite/drop → review evals/.triage/*.md (HUMAN gate)
# → add kept caseIds (+ capability/smoke) to evals/curation.ts
bun run langfuse:sync-datasets      # push curated cases → Langfuse `chatbot-eval` dataset (upsert by id)
bun run langfuse:seed-eval-config   # score-configs + Gemini llm-connection + managed evaluator (NO billing; online rule gated)
```

`promoteTrace` (in `dataset-sync.ts`) turns a failing PROD trace into a permanent dataset
case (`origin: "prod"`) — this is how the dataset grows into the real gold set.

## Model promotion (C3 gate)

Every change of a model-registry binding (`src/lib/model-registry/role-bindings.ts`) goes
through the promotion gate — never a hand swap. The gate runs the curated suite twice
**back-to-back** (baseline = current `chat` binding, then candidate, both pinned via the
`X-Model-Profile-Key` header on `/invoke`) and compares paired same-data/same-day runs.
Gate runs always include the `model-gate` tier (the per-model probes are the point);
a stored `--baseline-run` must therefore be a full (`--all`-equivalent) run.

```bash
cd backend/packages/ai
# service running in another pane; same env as evals:langfuse
AI_SERVICE_URL=http://localhost:8083 bun run evals:gate -- --candidate minimax-m3
# optional: reuse a stored baseline run (parity-checked against the current curated set)
AI_SERVICE_URL=http://localhost:8083 bun run evals:gate -- --candidate minimax-m3 --baseline-run gate-base-minimax-m2.7-20260611
# quick variant on the smoke subset (sanity only — promotion requires the full set)
AI_SERVICE_URL=http://localhost:8083 bun run evals:gate -- --candidate minimax-m3 --smoke
```

**Procedure:**

1. `bun run langfuse:sync-datasets` (dataset mirrors the current curated set) and, once
   ever after adding score names, `bun run langfuse:seed-eval-config`.
2. **Self-test first** (validates the harness + calibrates cost envelopes):
   `evals:gate -- --candidate <current chat profileKey>` — must pass trivially. Read the
   `cost-per-turn-usd` it prints, set the envelopes in `evals/langfuse/gate-config.ts`,
   then enable enforcement (`GATE_COST_CALIBRATED=1` or flip the default in a PR).
3. `evals:gate -- --candidate <newProfileKey>` — read the verdict table.
4. On PASS, the gate prints a ready-to-paste `evalGate` stamp. **The gate never
   writes the registry** — commit the stamp and the `profileKey` change on the SAME
   binding in ONE reviewed PR. The PR is the promotion.
5. After the flip deploys: run a full `evals:langfuse` on the new default as the fresh
   baseline.

**Pass criteria** (envelopes in `evals/langfuse/gate-config.ts`, env-overridable):
per-capability correctness drop ≤ 1 case-equivalent (ADVISORY by default — see below) ·
`tool-call-validity` ≥ baseline − ε · `zombie-rate` ≤ baseline + ε · `cost-per-turn-usd`
within the profile's `costClass` envelope (ADVISORY until calibrated) · avg latency ≤ 1.5×
baseline · `fallback-served` ≤ baseline + 1 candidate case (a silent
failover must not score as the candidate). The gate also prints a tool-calling **efficiency**
block (`avg-tool-calls` / `tool-error-rate` / `redundant-call-rate`) — ADVISORY (never failing)
until `GATE_EFFICIENCY_ENFORCED=1` + calibrated envelopes (same discipline as cost).

**Correctness is ADVISORY by default** (`correctnessEnforced: false`): a per-capability drop
past the case-equivalent threshold prints `≈` but does NOT disqualify — so a smarter frontier
candidate can gate through without one regression auto-failing it. The `≈` deltas are still
visible in the verdict table; read them. Re-arm the hard fail with `GATE_CORRECTNESS_ENFORCED=1`
(env) or a reviewed flip in `gate-config.ts` once the correctness thresholds are re-tuned for
the new flagship — same calibrate-then-enforce discipline as cost / efficiency.

**Caveats:** a stored `--baseline-run` is only comparable while the curated set is
unchanged (the gate aborts on caseId-set mismatch) and is looked up over the last year
(experiments API window); the parallel probes are
informational (the baseline may not support parallel calls at all); judge noise on small
deltas — prefer the full set and re-run before trusting a borderline verdict.

### What the gate does and does NOT govern (changed 2026-07-26)

**The gate no longer decides which models teams may select.** It used to: the picker
listed only `evalGate.status === "passed"` profiles for the flagship tier, which froze that
menu at two models while twelve sat `pending`. Gate runs are slow and costly, the suite is
not a fair enough judge to be a gatekeeper, and one profile already carried a hand-written
override explaining its verdict had been overruled.

Selection is now governed by `assessment.enabled` alone (`isSelectableForTier`). Adding a
model to the catalog needs **no eval evidence** — pick the latest version of a supported
brand, fill in its profile, ship it. If it underperforms on our tools, the team switches
model; that is their call.

**The gate governs exactly one thing: the APPLIED DEFAULT.** Changing
`ROLE_BINDINGS.chat` / `.workflow` requires that BINDING to carry
`evalGate.status: "passed"` with a run id, enforced by
`tests/unit/lib/model-registry.test.ts` — so a PR that swaps the default without a gate run
fails CI.

```bash
cd backend/packages/ai           # service running in another pane
AI_SERVICE_URL=http://localhost:8083 bun run evals:gate -- --candidate gpt-5.6-luna
```

Then commit the printed `evalGate` stamp **onto the binding**, next to the `profileKey` you
changed, in the same reviewed PR.

**The stamp moved off the profile on 2026-08-30.** A gate run does not measure a model in
the abstract — it measures a model doing a JOB, against the model that held the job before
it. A profile cannot express a pairing, and the cost was visible: `minimax-m3` carried a
stamp whose own comment called it the `chat` default four weeks after the flip moved `chat`
to `deepseek-v4-flash`. Nothing caught it, because the evidence was never tied to the
decision it was evidence for. It is now the last hand-written fact in the registry that no
API could supply — everything else a profile used to assert is read from a catalogue or a
price.

### Adding a model to the catalog (no gate needed)

**It is a command, not a pull request.** This used to be a nine-step checklist against a
hand-written profile — copy the catalogue facts, record the routed price, pin an `aaSlug`,
transcribe a verbosity figure off a web page, activate `nativeInput`. Every one of those is
now read from the row, so:

```bash
cd backend/packages/jobs && bun run models:sync      # discovers candidates
cd ../ai && bun run models:admin -- show <key>       # read what was measured
bun run models:admin -- promote <key>                # publish it to the hub
```

The nightly sync writes the catalogue facts, the pool median price, the endpoint stats and
the reasoning contract; `effective.ts` derives the profile. Nothing is typed by hand, so
nothing can be stale.

Two things still deserve a look after a promotion:

- **`FALLBACK_METRICS`** (`services/model-metrics/fallback.ts`) — only needed if the model is
  about to serve an internal ROLE, since those must render gauges in an AA-less environment.
- **`enabled`** — the sync applies the price budget itself, but check the hub shows what you
  expect. `models:admin -- disable <key> --reason cost` if not.

Verify with `bun run check && bun run test`, then `bun run models:admin -- audit`
(offline) and `bun run models:check --probe` (live routing, needs a key).

The picker's per-tier "recommended" badge tracks the code-default `ROLE_BINDINGS`, so
adding a model changes the available choices, never the recommendation.

**Reasoning steerability — DERIVED, not classified, and now USER-FACING.**
`STEERABLE_REASONING_KEYS` is computed from `catalog.reasoning.supportedEfforts`: a model is
steerable when OpenRouter accepts more than one effort level, which is exactly when raising
the level does something. It used to be a hand-maintained list of six keys, so every model
added after it was written silently reported "not steerable".

Since 2026-07-27 this is no longer an internal detail. The prompt bar's model selector was
replaced by a **thinking-depth picker**, so `selectableReasoningLevels(profile)` is literally
the menu a user sees — and a wrong entry there is a control that does nothing. It narrows the
raw ladder twice: a single-rung ladder yields `[]` (not a choice), and so does every
`style: "max-tokens"` profile, because the one such profile in the fleet (MiniMax M3, today's
applied default) measurably ignores the knob. Consequence to know before you debug it: **on
the current default the picker renders disabled with an explanation.** Four of the five
selectable flagship models do steer, so it comes alive as soon as a team switches model.

That makes `catalog.reasoning` load-bearing — copy it verbatim from OpenRouter, including
`mandatory` (Gemini and Grok cannot have reasoning switched off; never send them `none`).
A model with NO `supportedEfforts` honours only a token budget ⇒ `assessment.reasoning.style`
must be `"max-tokens"` (MiniMax M3, Claude Haiku 4.5).

`defaultLevel` therefore also became the depth most users get: it is the bottom of a
three-layer default (per-turn pick → team's stored level → this). Route every requested level
through `effectiveReasoningLevel`, never straight into `reasoningParamForProfile` — it drops
unsupported rungs AND the profile default itself, which is what keeps an untouched turn
byte-identical on the wire.

Choosing `defaultLevel` is still a judgement call, and the two axes that decide it are cost
and TAIL LATENCY, measured per model:

- GPT-5.6 Luna `xhigh` costs +1 % over `high` on our turn shape (the bill is cached-input
  dominated) while buying +11 % intelligence — but a hard prompt measured 118 s to the first
  answer token.
- GLM-5.2 `xhigh` measured **818 s** to the first answer token. Unusable for chat; it runs
  at `high`.

Note `max` exists in `ReasoningLevel` (OpenRouter accepts it on GPT-5.6 / Claude 5 / Inkling)
but the provider SDK's union stops at `xhigh`, so `reasoningParamForProfile` clamps `max`
down to `xhigh` on the wire. Remove the clamp when the SDK widens.

## External capability priors (leaderboards — never imported datasets)

Public benchmarks are PRIORS for choosing candidates and pre-filling expectations, not
grades. Read **BFCL v4** (gorilla.cs.berkeley.edu/leaderboard.html — tool calling, incl.
parallel/multi-turn/format-sensitivity) and **Artificial Analysis**
(artificialanalysis.ai — intelligence index, cost, latency) when shortlisting a
candidate profile. A profile's `evalGate.status` stays `pending` until OUR gate runs — a
leaderboard score is about someone else's harness.

Do NOT import benchmark datasets (τ-bench, GAIA, BFCL cases) into the Langfuse dataset:
foreign tool schemas measure nothing about our harness, licences are partly gated
(GAIA), and the leaderboard already publishes the generic signal for free. We borrow the
**method** instead — the `tool-portability` suite is BFCL-style probes on OUR tools, the
`instruction-following` suite is IFEval-style mechanical validators, `tool-call-validity`
is the BFCL-AST analogue (Zod `safeParse` on recorded tool-call inputs).

## Tool-calling efficiency scores (C11)

Beyond IF the turn succeeded (`correctness`), the harness measures HOW WELL it used
tools — computed mechanically from the observed `toolCalls[]` in
`evals/tool-efficiency.ts`, summarised onto `TaskOutput.toolEfficiency`, scored in
`evals/langfuse/evaluators.ts`. **All INFORMATIONAL** — never folded into `correctness`,
never gate-blocking in C11 (Anthropic: grade the outcome, report efficiency apart).

- **Item**: `tool-call-count`, `tool-error-rate` (errored calls / total, when calls > 0),
  `redundant-call-count` (identical tool+input repeats), `tool-budget-overage` (only for
  cases that declare a `budget`).
- **Run**: `avg-tool-calls`, `tool-error-rate` (aggregate), `redundant-call-rate`
  (fraction of cases with a redundant call). `error-then-retry` rides the run-level
  `tool-error-rate` comment (not seeded — named for good only once calibrated).

A case opts into a budget by declaring `budget: { maxToolCalls?, expectedTools? }` on the
`EvalCase` (see the `b2b-efficiency` suite). The budget is a LOOSE envelope: it flags
over-calling / off-plan tools, it does NOT punish legitimate exploration, and it cannot
make a correct answer fail. Enforcing any of these as a gate criterion is a future PR
(`GATE_EFFICIENCY_ENFORCED=1` once a baseline sets the envelopes in `gate-config.ts`).

## Cost

Every model call bills **OpenRouter**, on every surface. The difference is **bounded/on-demand**
(scripts, CI — you trigger them on a finite set) vs **continuous/automatic** (the online rule,
once enabled, judges a sample of every prod turn forever).

Each `evals:langfuse` run attaches **`cost-agent-usd`** (total) + **`cost-per-turn-usd`** to the
dataset run, and **`cost-per-page-usd`** when the run built pages. The figure comes from the
**server's own ledger** (`src/lib/turn-usage.ts`): every step's billed cost, counted in the process
that spent it, delegates included, and sent on the finish frame. `cost-per-page-usd` is the page
builder's bucket alone — the parent's steps are not part of what a page cost.
The Langfuse sum is still fetched and compared: a gap over 5% prints a warning and scores
**`cost-langfuse-drift`**. The in-process **judge** cost is not yet rolled in (constant across
agent-model comparisons; a follow-up).

**Check the telemetry before believing any cost.** The service prints
`[langfuse] tracing enabled — … integrations=N` at boot. `N` must be **1**. Anything higher means
the AI SDK telemetry integration was registered more than once and _every_ model call is exported
that many times — so every count and every cost read out of Langfuse is that many times too high,
with nothing downstream able to tell. This is not hypothetical: on 2026-09-05 a dev process that
had hot-reloaded 21 times reported **$129.50 for $5.89** of real traffic, and two code changes were
argued from the inflated numbers before anyone noticed. `src/lib/langfuse-registration.ts` now makes
it idempotent; `cost-langfuse-drift` is the alarm if it ever comes back another way.
For a run whose numbers you intend to act on, start the service with `bun run dev:clean`
(`--watch`, whole-process restart) rather than `bun run dev`.

## Methodology guardrails (do not violate)

- **Failure taxonomy is DISCOVERED, never seeded a priori** — a pre-defined list causes
  confirmation bias, and score configs cannot be deleted. It comes from error analysis
  (open-code ~30-50 prod traces → cluster), gated until prod traces exist. The seeded
  configs are only objective metrics (`correctness`, `pass-rate`, `no-error`, `latency-ok`);
  `failed-check` is a mechanical "which assertion broke" label, not the taxonomy.
- **Synthetic cases are a seed, not the gold set** — the real dataset grows from prod failures.
- **The flagship is held to a perfect score.** MiniMax M3 (current flagship) is expected to score
  `correctness: 1.000` on EVERY curated case — it is capable of it. A sub-1.000 case is never
  accepted as noise: it is a signal to fix one of two things, decided by reading the trace.
  (a) The model genuinely missed → fix the **system** (prompt line, tool description, routing, or even the base structure of the chatbot).
  (b) The model behaved correctly but was penalized → fix the **eval** (an over-strict assertion,
  a mis-specified expected tool, or a bad judge rubric). Example: demanding a `LIMIT` on a
  `COUNT(*)` query, or asserting `searchKnowledge` when a structured `listRecords`/`querySql`
  path answers the prompt just as correctly. Keep iterating until M3 is at 1.000 with no
  capability regression.
- The **online billing rule** is created in the UI (verify its observation filter against live
  data first — `chatbot-turn` is the TRACE name, not necessarily a filterable observation name).

## For a future Claude Code session (analyse traces / improve the chatbot)

Assume the chatbot is in **production** and Langfuse holds real prod traces. **Always load the
`langfuse` skill first and use its CLI** (`npx langfuse-cli api …`, creds in `backend/packages/ai/.env`)
to read traces/scores/datasets — never guess the API.

**Where everything lives (who does what):**

- **Observability** — Langfuse, filtered by `environment` (`production` vs `development`). EVERY AI
  call is a named, costed observation; the chat turn is the **`chatbot-turn`** trace (input = user
  message, output = final answer, `totalCost` = full turn cost). Other names: `pre-extract`,
  `vectorize`, `rag-multi-query`, `vision`, `embeddings`, `rerank`, `ocr`, `web-search`, `e2b-*`.
- **Real-user signal** — `user-feedback` (👍/👎) and `user-retry` scores on prod traces (Phase 2).
  The 👎 traces are the highest-signal seed for error analysis.
- **Eval loop** — this `evals/` dir. Engine: `runner.ts` + `judge.ts` (graded, Gemini). Curated
  cases: `curation.ts` → Langfuse dataset `chatbot-eval`. Experiment/scores: `langfuse/`. Baseline =
  the latest full `evals:langfuse` dataset run (correctness overall + per-capability + cost).
- **Prompts** — Langfuse Prompt Management (`fretik-chatbot-system`, `fretik-chatbot-sub-agent`),
  git source = the `.md` files; edit `.md` → `bun run langfuse:seed-prompts`.

**To ANALYSE eval/prod traces:** follow the `langfuse` skill's error-analysis method (sample →
open-code → cluster → taxonomy → decide). Sample real failures (low `user-feedback`, low online
score if enabled, or a random+stratified set). Drive sampling + annotation queues via the CLI; the
human open-codes. The taxonomy is DISCOVERED here, never assumed.

**To IMPROVE the chatbot (measured):** error-analysis names a concrete failure → fix at its source
(prompt / tool description / harness) → re-run `evals:langfuse` (or `--capability X`) and require a
gain over the baseline with NO per-capability regression and acceptable `cost-per-turn-usd` → add the
fixing case (or promote the prod trace via `promoteTrace`) so the win sticks. Measure the result, not
the path.

## Gotchas

- `AI_SERVICE_URL` is not in `.env` — pass it inline; the service must be running.
- `dataset-sync` / any `evals/` import pulls `@fretik/shared/db` (memory cases) → triggers DB
  migrations at load and the process lingers on open connections; the work completes first.
- `scripts/*` are OUTSIDE the `tsconfig` include — `bun run typecheck` does NOT cover them;
  verify with a temp tsconfig that adds `scripts/**`.

---

# Production deployment — operator actions (one-time, before first prod traffic)

These require a human with server / Dokploy / Langfuse-UI / GitHub access — Claude cannot do
them. The full Langfuse chantier is merged to `main` (merge commit) but **NOT pushed**, so a
push doesn't accidentally deploy before the remaining steps are checked.

1. **Prod env vars** (Dokploy service env) — ✅ **DONE** (confirmed 2026-06-02). For reference, the
   load-bearing ones: `LANGFUSE_TRACING_ENVIRONMENT=production` (separates prod from dev across
   traces/scores/sessions/datasets — dev is `development`), `LANGFUSE_PUBLIC_KEY` /
   `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`, `LANGFUSE_RELEASE=<git sha>`, and REAL cost rates
   `E2B_PRICE_PER_SECOND` / `TAVILY_PRICE_PER_CREDIT` (defaults are approximations).
2. **Langfuse server seeding** — ✅ **already DONE** on `langfuse.fretik.com`. Prompts
   (`fretik-chatbot-system` + `fretik-chatbot-sub-agent`, label `production`) and eval-config
   (score-configs + Gemini judge connection + managed evaluator) are **project-level**, separated
   from prod only by the `environment` attribute — NOT by project — so prod reads the same seeded
   data. The `langfuse:*` scripts are plain HTTPS API calls (run from anywhere with the Langfuse
   creds, e.g. locally). Re-run **only**: `bun run langfuse:seed-prompts` after editing a prompt
   `.md` (publishes a new `production` version); both scripts once against a NEW project IF prod
   ever uses separate Langfuse keys (not the case today).
3. **Frontend (separate repo):** ship the Phase-2 feedback UI (CopyButton, FeedbackThumbs,
   useChatFeedback, i18n) and click-test: 👍/👎 + comment on an assistant turn → score+comment
   on that turn's trace in Langfuse + thumb persists across reload.
4. **(Optional) Manual eval workflow secrets/vars** — only if you'll trigger
   `langfuse-experiment.yml` (`workflow_dispatch`) from CI. Secrets: `LANGFUSE_PUBLIC_KEY`,
   `LANGFUSE_SECRET_KEY`, `OPENROUTER_API_KEY`, `EVAL_INTERNAL_KEY`. Vars: `LANGFUSE_BASE_URL`,
   `EVAL_TEAM_ID`, `EVAL_ORGANIZATION_ID`, `EVAL_USER_ID`. The target service URL is a run input
   (`ai_service_url`) pointing at a reachable, data-bearing, NON-prod service. NOT a deploy
   prerequisite — pre-merge evals run locally against dev.
5. **Push + deploy.** Once 3 is done: `git push origin main` → build the single Docker image →
   deploy via Dokploy. Migrations are applied at container boot by the services that
   carry `RUN_MIGRATIONS=true`, under an advisory lock — see `docs/OPERATIONS.md`.

> OpenRouter "Broadcast" is already disabled (no stray `env=default` traces) — no action needed.

# Long-term roadmap — once prod traces accumulate (the improvement engine)

Gated on real prod traffic. Until traces exist, the offline loop + objective metrics are the ONLY
signal — do NOT invent a failure taxonomy or tune against synthetic targets.

1. **Enable the online managed eval rule** (sampled LLM-judge on prod) — create in the Langfuse UI;
   **first verify the observation filter on a real prod trace** (`chatbot-turn` is the TRACE name,
   not a filterable observation name — `observations list --name chatbot-turn` returns 0). Gate with
   `SEED_ONLINE_RULE=1` + a spend cap. This is monitoring/harvesting, NEVER the improvement metric.
2. **Error analysis (methodology core)** — once ~30–50 representative traces exist (sample low
   `user-feedback` 👎 + a random+stratified set): drive sampling + an Annotation Queue via the CLI,
   the HUMAN open-codes ~30–50 → cluster into a DISCOVERED failure taxonomy (never seed one a priori).
   Calibrate the Gemini judge against the human labels (skill `langfuse/judge-calibration.md`).
3. **Grow the gold set from prod** via `promoteTrace` (`evals/langfuse/dataset-sync.ts`) — each
   confirmed failure → a permanent `origin:prod` regression case. This is how extraction breadth
   (deliberately deferred — synthetic-fixture cases were tried then reverted) and every capability
   grow representatively. The synthetic 20 stay as a smoke seed.
4. **Phase 7 — measured harness fixes**, error-analysis-driven: each named failure → fix at source
   (prompt / tool description / harness) → re-run `evals:langfuse`, require a gain over baseline with
   NO per-capability regression + acceptable `cost-per-turn-usd` → promote the fixing case.
   NOTE: the n=20 set is judge-noisy (a case flapped 1.0/0.75/0.875 across runs) — use multiple
   trials and/or the grown set before trusting small deltas.
5. **Phase 8 — model strategy, data-driven**: compare agent models on the grown dataset
   (correctness/capability + cost-per-turn + latency). Mechanism: the **C3 promotion gate**
   (`evals:gate -- --candidate <profileKey>`, see "Model promotion" above) — model env vars no
   longer exist; bindings live in `src/lib/model-registry/role-bindings.ts` and flip via a reviewed PR.
   Adopt hybrid escalation (cheap default + escalate hard steps) only where experiments prove it pays.
6. **Phase 6 — GEPA/DSPy auto-optimization**: once taxonomy + prod dataset are solid, pull the
   dataset + judge rationales, let a strong reflection model propose prompt / tool-description / skill
   edits, push candidates as Langfuse prompt versions (label `candidate`) → PR with measured gain →
   human review before `production`. **This is the trigger to move tool descriptions into Langfuse
   prompt management** — not before (they're Zod-schema-coupled in code today).
7. **Analytics / dashboards**: Custom Dashboards (cost/conversation, cost/team, latency p50/p95,
   error-rate by capability, cache ratio) segmented by user/tag/metadata/environment; Score Analytics
   for quality trend over time.
8. **Sampling**: when traffic scales, set trace sampling to bound volume/cost.

# Known minor (non-blocking, prod-safe)

- **Embedding batch cap divergence when Langfuse is OFF** (`lib/model-instrumentation.ts`): the
  `overrideMaxEmbeddingsPerCall: 20` cap rides the cost middleware, applied only when Langfuse is
  enabled. Prod always has Langfuse on → unaffected; a Langfuse-off env (local without creds /
  outage) reverts to the provider default batch size during indexing. Move the override into an
  always-applied middleware if you ever run prod-scale indexing with Langfuse off.
- **Judge in-process cost** is not yet rolled into the run cost (constant across agent-model
  comparisons; minor).
- **Cost shows $0 on the experiment view** — the dataset-run `experiment-item-run` traces carry $0
  because the real model calls run in the AI service as separate `chatbot-turn` traces. The real
  cost is the run-level `cost-agent-usd` / `cost-per-turn-usd` SCORES on the dataset run. To make
  cost show natively on the experiment, add distributed-tracing (traceparent) propagation from the
  eval harness to the AI service.
