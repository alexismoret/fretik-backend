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

### Two eval teams — read and write (2026-09-11)

| env                  | team         | suites                                                   |
| -------------------- | ------------ | -------------------------------------------------------- |
| `EVAL_TEAM_ID`       | the real one | `evals:langfuse` (incl. `memory-recall`), `evals:recall` |
| `EVAL_WRITE_TEAM_ID` | `eval-write` | `evals:memory`, `evals:chain`                            |

The write-side suites make the agent WRITE memories and episodes, and they ran
on the same team everything else read from. One residue is enough to change a
result elsewhere: `chain-convention-promoted` went 10/10 → 0/10, and the most
coherent explanation is `learned/meridian-bon-de-commande.md` left behind by
`evals:memory` — `promote-episodes.ts` loads every `learned/%` row into
`<existing_learned>`, whose prompt says "NOOP if already covered".

```bash
bun run evals:ensure-write-team   # idempotent, by team name; prints the id
# → put the id in .env as EVAL_WRITE_TEAM_ID
```

`evals:memory` and `evals:chain` **refuse to start** without it rather than
falling back to `EVAL_TEAM_ID`: a silent fallback rebuilds exactly the
contamination the split exists to remove, and it does so invisibly. Both now
clean their fixtures at the END of the suite too — pass `--keep` to inspect
rows, `--cleanup` to clean without running.

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

### `STANDING_MODE` / `X-Standing-Mode` — how to run the standing-layer A/B

Exactly the shape of `RECALL_MODE` above, for exactly the same reason: the
service reads `STANDING_MODE` once at module load, so without a per-request
override two arms are one restart apart and stop being paired.

| arm        | what serves `<standing_memory>`                                                  |
| ---------- | -------------------------------------------------------------------------------- |
| `digest`   | the generated `team_memory_digests` row (`services/memory/build-team-digest.ts`) |
| `episodes` | `services/episodes/list-standing.ts`, rendered deterministically, per reader     |
| `none`     | nothing — **the control**, and the only thing that makes either number readable  |

```bash
for ARM in none episodes digest; do
  AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- \
    --suite memory-recall --repeats 10 --recall-mode adaptive \
    --standing-mode $ARM --concurrency 3 --run-name p3ab-$ARM
done   # sequential. Compare PER CASE.
```

`/invoke` answers **400 `UNKNOWN_STANDING_MODE`** on anything else, deliberately:
an A/B that silently falls back to the default measures one arm twice.

**Three things to set up first, each of which silently voids the comparison.**

1. **Rebuild the digest, and check it cites episodes.**
   `POST /internal/memory/build-team-digest` with `force: true`, then read
   `sources.episodeIds`. Measured 2026-09-11: before the rebuild the eval
   team's digest cited **0 episodes** — it had last been built while the recall
   fixtures were still stamped June 2026, outside its 60-day decision window —
   so its two sections were conventions and entity labels, and the arm behaved
   indistinguishably from `none`. After the rebuild: 8 episodes and a
   `## Current decisions` section. A `digest` arm reading a stale row is not a
   measurement of the digest.
2. **Check the jobs service is NOT running.** Seeding fixtures writes memories,
   which enqueues a digest rewrite on a 5-minute debounce. A rewrite mid-run
   changes the `digest` arm's block underneath the repeats.
3. **`EVAL_OTHER_USER_ID` must be set**, or `mr-private-leak` throws rather than
   passing for the wrong reason — and that case gates the standing block too:
   the private Sirius episode must not appear in it. Verified against real data
   on 2026-09-11: the owner's block carries it (18 rows visible), the other
   member's does not (7 visible).

**The fairness note, which belongs in any write-up of the result.** The recall
fixtures seed at TEAM scope (`userId: null`), while `distillConversation` writes
a PRIVATE episode whenever a conversation has one participant. So the eval team
flatters the `digest` arm relative to a real one-person team, where its decision
section is empty by construction. Eleven of the eighteen episodes a reader sees
on the real dev team are private — a team-scoped artefact structurally misses
61 % of them. **If the digest does not win here, it wins nowhere.**

#### Result — 2026-09-11, three arms, `p3ab-*` / `p3ab8-*` / `p4fix-*`

Control on all 15 cases (`p3ab-none`, 150 items, 43m45s): **137/150**. Only three
cases were not 10/10 — `mr-contextless-status` 3/10, `mr-contextless-brief`
6/10, `mr-abstain-general` 8/10. The two arms then ran the 8 cases that can
decide: the three contextless, the four must-NOTs, and `mr-memory-convention`.

| case                          | `none` | `episodes` | `digest` | calls n/e/d      |
| ----------------------------- | -----: | ---------: | -------: | ---------------- |
| `mr-contextless-status`       |   3/10 |       9/10 |    10/10 | 8.0 / 2.9 / 2.3  |
| `mr-contextless-brief`        |   6/10 |      10/10 |    10/10 | 11.9 / 5.9 / 8.0 |
| `mr-contextless-week`         |  10/10 |      10/10 |     9/10 | 3.8 / 4.5 / 4.8  |
| `mr-greeting`                 |  10/10 |   **4/10** |    10/10 | 0.0 / 0.0 / 0.0  |
| `mr-abstain-general`          |   8/10 |       8/10 |     6/10 | 1.0 / 0.8 / 1.1  |
| `homonym`/`convention`/`leak` |  10/10 |      10/10 |    10/10 | —                |
| **total**                     |  67/80 |      71/80 |    75/80 |                  |

**A standing block is worth having.** Both arms turn the two discriminating
cases from 3/10 and 6/10 into 9-10/10, and they do it while SPENDING LESS: on
`mr-contextless-brief` the control burned 11.9 tool calls and 208 s per turn
reconstructing by hand what the block states — 22 calls and 12 minutes on the
worst repeat. That is the answer to "does this earn its place": yes, and the
evidence is a case that cannot be answered by retrieval at all.

**Then `episodes` broke a must-NOT, and the cause was one sentence of prompt.**
`mr-greeting` 10/10 → 4/10. All six failures answered "Bonjour !" politely, under
the length cap, while naming the week's Nordwind delivery and the Callisto
follow-up. The scaffold said _lean on it when the message names nothing to
search for_ — and a greeting names nothing either, so the rule covered a case it
never meant to. Rewritten as a positive condition ("asks for a state of play")
with small talk excluded by name.

| after the fix (`p4fix-*`) | `episodes` | `digest` |
| ------------------------- | ---------: | -------: |
| `mr-greeting`             |  4 → 10/10 |    10/10 |
| `mr-contextless-status`   |  9 → 10/10 |    10/10 |
| `mr-contextless-brief`    |      10/10 |    10/10 |
| `mr-abstain-general`      |       8/10 | 6 → 9/10 |
| subtotal                  |      38/40 |    39/40 |

**Re-run BOTH arms after a shared-prompt fix.** The fix lives in the block's
shared intro, and it moved the digest too (`mr-abstain-general` 6 → 9). Comparing
a fixed arm against the other arm's pre-fix score would have manufactured a win.

**The verdict is a TIE, 78/80 each**, and the honest caveat is that this total
splices four cases measured under the old prompt onto four measured under the
new one. The only clean comparison is the four re-run cases: **38/40 vs 39/40**,
one point at n=10, which is not a separation.

Decided by the pre-registered rule, not by the totals: `digest` is retained only
if it BEATS `episodes` on the contextless cases — it does not (equal on two,
9/10 vs 10/10 on the third) — while `episodes` is retained if no case regresses
against `none`, and after the fix none does. The rule also named the tie in
advance and gave it to `episodes`.

What decides it beyond the score, all of it measured rather than argued:

|                                    | `episodes`                   | `digest`                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cost per refresh                   | one indexed query            | **one LLM call per team**                                                                                                                                                                       |
| defects observed in its first week | none reachable by a renderer | **5** (inverted link asserted as fact with a resolving marker, a third of the sections dropped in 1 of 10, 16 lines lost to a wrong marker prefix, a block outliving its rows, timeout at 4/10) |
| episodes a reader can see          | **18 of 18**                 | 7 of 18 — misses 61 %                                                                                                                                                                           |

#### Closure and verdict — 2026-09-11, `p4fix-*` / `p4close-episodes`

The `episodes` arm lost 6 points on `mr-greeting` and the cause was one
sentence of prompt, not the renderer (see the previous section). After the fix,
**both** arms re-run on the four affected cases:

|                         |    `episodes` |     `digest` |
| ----------------------- | ------------: | -----------: |
| `mr-greeting`           | 4 → **10/10** |        10/10 |
| `mr-contextless-status` | 9 → **10/10** |        10/10 |
| `mr-contextless-brief`  |         10/10 |        10/10 |
| `mr-abstain-general`    |          8/10 | 6 → **9/10** |

**78/80 each. A tie**, and the totals splice four cases measured under the old
prompt onto four under the new one — the clean comparison is 38/40 vs 39/40.

Closure at n = 30 on `episodes`:

| case                    |      n=30 |                  |
| ----------------------- | --------: | ---------------- |
| `mr-contextless-status` | **30/30** | CLOSED           |
| `mr-contextless-brief`  | **30/30** | CLOSED           |
| `mr-contextless-week`   | **30/30** | CLOSED           |
| `mr-greeting`           | **30/30** | CLOSED           |
| `mr-abstain-general`    |     21/30 | open — see below |

`mr-abstain-general` is NOT a regression of this layer: targeted n = 30 runs the
same day gave **21/30 under `digest`** and 23/30 under `none`. The case lives at
~70 % whatever serves the block; it is the previous chantier's open case.

Decided by the pre-registered rule, not the totals: `digest` was retained only
if it BEAT `episodes` on the contextless cases, which it cannot now that those
are 30/30; `episodes` was retained if nothing regressed against `none`, and
after the fix nothing does. The rule named the tie in advance and gave it to
`episodes`.

### `mr-written-memory-recalled` — the write end, finally measured (P5.2, 2026-09-11)

**10/10, zero failed assertions, ~25 s per turn, $0.011 per turn** (concurrency
1). Every other case in the suite reads a fixture someone else seeded; this one
is the only measurement of the loop the product actually promises — the
assistant is told to record a rule in ONE conversation and has to know it in
the NEXT. Its seed plays the write turn for real through `/invoke`, so a
failure attributes to a stage: the seed aborts when the agent never wrote, the
assertions fail when it wrote and recall never surfaced it.

**The value is 45 days, not 30.** 30 is the commercial default a model produces
from general knowledge, so a case asserting 30 passes on a turn that read
nothing. Pick the fixture value a correct answer cannot reach by guessing.

**The first 10/10 was void, and the reason generalises.** The cleanup matched
`"validité de 45 jours"` — the phrasing of the INSTRUCTION. The agent does not
keep it: it wrote "Validité de l'offre : 45 jours", the cleanup deleted
nothing, and the next repeat's purge missed it for the same reason. Nine
repeats then ran with the previous repeat's memory still on the team, so the
write stage was not load-bearing and the run measured recall of a leftover.
**Key a marker on what the AGENT produces, never on what you told it** — the
value survives rewording because it IS the fact, and it is now the same
constant the assertion uses, under one invariant: nothing else in the universe
may carry it, or the case is vacuous either way.

Two things to know before running the full suite with it:

- it costs roughly **two turns**, being the only case that plays one in its seed;
- it writes a TEAM memory to the shared read team, which shows up in every
  concurrent turn's `<memory_index>` until its cleanup runs. The window is one
  case; at `--concurrency 3` a handful of turns overlap it. The cleanup deletes
  by content, not path, because the agent names its own file — three different
  paths in three repeats.

Observed, not caused by this case and not chased here: **3 of 10 turns were
answered by the FALLBACK agent** rather than the bound model (`fallback-served`
scores it), and the one inspected had visibly degraded output — the same reply
concatenated three times.

### `chain-workflow-turn-one` — the run that starts knowing (P5.3, 2026-09-11)

**30/30, ~1.5 s per repeat.** A workflow run has nobody typing, so retrieval
has no user message to match: what stands in for it is the workflow's own name
and goal, with the trigger payload as the recent tail. P2 shipped that
substitution and nothing measured it. It now lives in
`agents/workflow/turn-one-memory.ts` as `recallForWorkflowTurnOne`, with the
case asserting both surfaces of turn 1: the index NAMES the convention's path,
and recall BRINGS THE CONVENTION BACK from a goal that never mentions it.

The marker ("contrôle qualité photo") is deliberately absent from the goal
("traiter une réception de marchandise… contrôle à l'arrivée, écarts, mise à
jour de la fiche"). A marker echoing the goal would pass on lexical overlap and
prove nothing about the substitution.

Paired with its own negative, in the same case: a run with **no acting user
gets NO block**. Recall scopes private rows to the caller, so a team-wide block
there is the leak — and an exclusion-only assertion is satisfied by a function
that returns nothing.

**Two harness traps this case walked into first, both worth knowing before
writing another in-process eval.** The smoke run was 0/3 and neither failure
was the product:

1. **Recall caches for 15 s, in-process, keyed on the message.** A run's query
   is its workflow name and goal, which never change — so N repeats are N
   identical keys and the suite scores ONE recall call N times. Three repeats
   produced one `[recall]` line. `recallForWorkflowTurnOne` takes an
   eval-only `bypassCache`, like `recallFor` already did in this suite.
2. **The FIRST embedding call of a process times out** against the remote
   provider and `hybrid-search` falls back to its lexical arms — logged as
   "embedding unavailable — serving lexical arms only", with no error and no
   semantic candidates. Combined with (1) that one cold failure was cached and
   served to every repeat. The runner now burns it on a query no case scores.

And the trap under those two: **the suite's own cleanup deletes its fixtures at
the end of a run, so a diagnostic script run afterwards measures an empty
team.** Two rounds of "the judge is rejecting my memory" were spent on a
database that no longer held it. Seed before probing, or probe with `--keep`.

### TRIED AND DELETED: the LLM team digest (2026-09-11)

A background job wrote one prose summary per team into `team_memory_digests`,
served on every turn without retrieval. Built, gated hard, measured, deleted.
**Do not propose it again without reading this section.**

It did not lose on quality — it tied. It lost on:

- **cost shape**: one LLM call per team per refresh, against one indexed query;
- **defects only a generation step can have**, five in its first week: an
  inverted link rendered as fact carrying a marker that RESOLVED (so every gate
  passed it), a third of the sections dropped in 1 generation of 10, 16 lines
  lost to a wrong marker prefix, a block outliving the rows it cited by a day,
  the timeout hit 4 times in 10;
- **scope**, which no gating fixes: `distillConversation` writes a PRIVATE
  episode when a conversation has one participant. Measured on the real dev
  team, a reader sees 18 episodes in the window and 11 are private — a
  team-scoped artefact misses 61 % of them, and on a one-person team (every
  team's first weeks) its "current decisions" section is empty by construction.

Three lessons worth more than the verdict:

1. **A second model pass over model output is a summary of summaries.** The
   distiller already wrote those episode summaries and has its own eval. The
   value was in the writing, not the re-writing.
2. **An index never suppresses retrieval.** The digest's one-line compression
   of a convention replaced the VERBATIM memory in `<active_memory>` and cost
   `mr-memory-convention` a point — the verbatim carried literal columns the
   compression dropped. The duplicate costs one line; the suppression cost a
   case.
3. **Form changes what the model does with the same facts.** Sectioned prose
   read as reference material; a dated feed of recent lines read as news to
   pass on, which is why only the episode arm volunteered the week's deliveries
   to someone who said "Bonjour". Same content, different behaviour.

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

#### Phase 0 frozen baseline — 2026-09-10, 23 cases × 10 repeats, both modes

Taken immediately before the HNSW work, so it is the "before" every Phase 1
number is read against. `p0-recall-adaptive` / `p0-recall-judge`.

| metric                   |             adaptive |            judge |
| ------------------------ | -------------------: | ---------------: |
| score                    |     **23/23** stable | **23/23** stable |
| gather p50               |               767 ms |           776 ms |
| gather p90               |             1 042 ms |         1 044 ms |
| knowledge arm p50        |               747 ms |           747 ms |
| judge p50 (when it runs) |               956 ms |           973 ms |
| escalation               | 100/230 = **43.5 %** |            100 % |

Two things to take from it, neither visible in a mean:

- **The knowledge arm IS the gather.** 747 ms of a 767 ms p50, and the
  `[hybrid]` split says 673 ms of that is the semantic arm — the Seq Scan. The
  headroom Phase 1 is going after is essentially all of it, and what remains
  underneath is the reranker's ~300 ms.
- **~1 % of turns pay a 6-12 second pre-turn, and nothing bounds it.** Two
  gathers in 230 came back at **6 288 ms and 12 380 ms** while p90 sat at
  1 044 ms. That is the cold query-embedding path, which has no timeout at all
  (the `embed p50 2 ms` figure above is the Redis cache-hit path and says
  nothing about it). A p50 that improves while that tail stays unbounded is not
  the reliability the work is for — `AbortSignal.timeout` on the query embed is
  the fix, and this is its before-number.

#### Phase 1 gate — 2026-09-10, after `ef_search=400` + `strict_order`

Same 23 cases × 10 repeats, same fixtures, same corpus (20 108 knowledge rows).

| metric                             | adaptive         | judge            |
| ---------------------------------- | ---------------- | ---------------- |
| score                              | **23/23** stable | **23/23** stable |
| knowledge arm, `semantic` p50      | **233 ms**       | 257 ms           |
| knowledge arm, `semantic` p90      | 322 ms           | 320 ms           |
| knowledge arm, rows                | **150/150**      | **150/150**      |
| `documents` arm (118 rows), p50    | 297 ms           | 338 ms           |
| `workflows+pages` (6 rows), p50    | 149 ms           | 149 ms           |
| famine warnings (690 searches ea.) | **0**            | **0**            |

Against the Phase 0 figure for the same arm in isolation, **476 ms → 233 ms,
−51 %**. Read the three rows together rather than the first one alone:

- **The arm that scans 20 108 rows is now faster than the arm that scans 118.**
  That inversion is the index working, and it is a better proof than the
  absolute number — `documents` is an exact scan over its own partition and did
  not change, so it is a control.
- **149 ms of every one of those numbers is fixed cost, not search.** A six-row
  arm cannot be scanning for 149 ms; that is what the transaction the `SET
LOCAL` requires costs at ~32 ms of RTT to a remote database (BEGIN, tune,
  SELECT, COMMIT). Backing it out, the knowledge arm's actual scan went from
  ~327 ms to ~84 ms — about 4×. In production, where the database is local,
  the fixed part is roughly zero and the reported number should approach the
  scan itself.
- **The plan's `≤ 20 ms` gate is not measurable from here** and was withdrawn
  before this run: 20 ms is the figure an `EXPLAIN` reports server-side, and no
  client-side timing on this topology can go below its own round trips.

**The Phase 0 line `[hybrid] semantic=673` above is a POOLED number** — it
predates the arm label and mixes a 20 000-row query with a 118-row one and a
6-row one. It is kept for the record, but it is not the "before" of anything;
the isolated 476 ms is.

#### Answer-level after Phase 1 — 12 × 10, `adaptive`, `p1-mr-adaptive`

Same suite, same `--concurrency 3`, same model (`deepseek-v4-flash` on every
case — checked, because the harness logged `[model-live] database read timed
out — serving stale` at boot and an empty registry would have changed the model
and silently invalidated the comparison).

| case                      | Phase 0 `adaptive` | after Phase 1 |
| ------------------------- | -----------------: | ------------: |
| the nine retrieval-shaped |              10/10 |     **10/10** |
| `mr-abstain-general`      |               8/10 |      **9/10** |
| **`mr-broad`**            |           **6/10** |      **9/10** |
| `mr-private-leak`         |    (not baselined) |          9/10 |
| overall correctness       |              0.985 |     **0.995** |
| overall pass-rate         |              0.942 |     **0.983** |

**No case regressed, and the two that were weak improved.** `mr-broad` is the
one the plan named as the entire measured cost of dropping the judge; it is
worth re-reading Phase 4 in that light, since part of what it was meant to
recover has already come back.

> **CORRECTION (2026-09-11): those two 9/10 are not a baseline.** Both cases
> were re-run targeted at **N = 30** and came back `mr-abstain-general` 21/30
> and `mr-broad` 19/30 — and a CONTROL arm with the standing block removed
> entirely gave 23/30 and 22/30, so the block is not what moved them. They are
> bimodal at roughly 65-75 %, at which rate a 9/10 draw happens about 15 % of
> the time. A single N = 10 sample of a bimodal case is a draw, not a
> measurement, and reading "8/10 → 9/10" as an improvement was reading noise.
> **Nothing decides on a contested case below N = 30** (the closure bar is
> ≥ 29/30 — see "Methodology guardrails"). Everything in this table's other
> rows — the nine retrieval-shaped cases at 10/10 — is unaffected, because a
> case that never fails is not the one this correction is about.

The `mr-private-leak` failure is worth naming precisely, because its shape is
the opposite of what the case is for: the privacy check (`no-private-budget-
ceiling`) PASSED, and what failed was the POSITIVE control — that repeat did not
find the lease document at all and concluded "only 7 documents in total". Tool
choice variance (it counted with `querySql` instead of searching), not a leak
and not a scope bug; the other nine repeats found it.

**What this run does NOT establish.** TTFT p50 went 2 205 → 7 218 ms, average
latency to 50 s and cost to $0.013/turn, with more tool calls per turn
(`tool-budget-overage` 9.167). That is not attributable from here: the run was
taken with the frontend and API also running on the same laptop, and this file
already warns that `ttft-p50-ms` is unreadable at concurrency 3. The pre-turn
number that IS clean is the recall suite's, which runs in-process and does not
include the agent's tool loop: gather p50 705 ms, max 1 760 ms, zero gathers
over 3 s.

To settle it, one controlled A/B: restart the AI service with
`SEMANTIC_SCAN_MODE=exact` and re-run this suite back to back. That is the only
way to separate the HNSW change from machine load, and it needs a service
restart, so it is an operator action rather than something the harness can do.

#### Where the gather's time goes now (2026-09-10, after Phase 1)

The knowledge arm is no longer the constraint. From the `[search]` lines of the
23/23 run, 230 turns, means per arm:

| arm                         |  total | hybrid | **rerank** | candidates |
| --------------------------- | -----: | -----: | ---------: | ---------: |
| `documents`                 | 713 ms | 313 ms | **400 ms** |         50 |
| `memories+episodes+records` | 561 ms | 259 ms |     301 ms |         50 |
| `workflows+pages`           | 449 ms | 174 ms |     274 ms |      **6** |

The gather costs `max(arm)`, so **`documents` is the critical path and the
reranker is 56 % of it**.

**Reranking SIX candidates costs 274 ms.** That number is the useful one: it is
almost entirely the HTTP round trip, not cross-encoder compute. It also corrects
the reasoning written into `services/recall/recall.ts`, which defends three
separate rerank calls on the grounds that merging them "would trade three
parallel calls of ≤50 documents for one serial call of ≤150, i.e. roughly triple
the rerank compute … to save two round-trips that overlap anyway". The compute
is not the cost. The conclusion survives — one merged call would pay the fixed
cost once but the marginal cost three times, and the three parallel calls
already overlap — but not for the stated reason, and anyone optimising here
should start from the measurement rather than the comment.

What this redirects: the remaining lever on the gather is the reranker (Phase 6),
not more round-trip collapsing (Phase 1.5, measured irrelevant: `anchor` 219 ms
and `graph` 72 ms against `documents` 695 ms, under a `max`).

#### TRIED AND REVERTED: the tuning on the connection, and a bigger pool

The `SET LOCAL` above needs a transaction, and that transaction is four round
trips for a query worth one. libpq startup options (`-c hnsw.ef_search=400 …`)
put the same settings on the CONNECTION instead, which removes it. The mechanism
works — all of this was verified, and none of it is why it was reverted:

- applied on the FIRST statement of a cold pool, and on every one of four
  concurrent backends (unlike node-postgres's `connect` event, which the pool
  does not await, so a query can race ahead of its `SET`);
- verified through drizzle: `current_setting('hnsw.ef_search')` → `400`;
- safe where pgvector is absent — Postgres accepts an unknown PREFIXED setting
  as a placeholder and refuses the connection only for an unknown bare one.

It was reverted because it is slower here. Same 23 cases × 10 repeats:

| configuration                           | knowledge `semantic` p50 | gather p50 | score     |
| --------------------------------------- | -----------------------: | ---------: | --------- |
| **transaction + `SET LOCAL`** (shipped) |               **233 ms** | **705 ms** | **23/23** |
| connection tuning, pool `max = 10`      |                   381 ms |   1 020 ms | 23/23     |
| connection tuning, pool `max = 24`      |                   617 ms |   1 293 ms | **18/23** |

**The isolated probe said the opposite** — one search at a time went 279 ms →
87 ms — and that is the lesson worth keeping. Three arms run concurrently here,
each with three statements; a probe that issues one query at a time does not
describe that system, and a 3× improvement measured that way inverted under the
real workload.

Two further readings from the failed run, both useful:

- **The pool at 24 is worse than at 10 against a REMOTE database.** Every
  additional connection is a handshake over the internet, and the eval process
  is short-lived enough to pay them inside its own measurement. A long-lived
  production service with a local database is a different topology; if this is
  revisited, `pool.waitingCount` is the number to look at, not a query timing.
- **The 18/23 was not a retrieval failure.** 12 of 230 turns lost their semantic
  arm to the 2.5 s embedding timeout — the whole process was slower, the
  embedding call went over the ceiling, and the lexical fallback answered
  instead. The score followed. Worth remembering that a timeout defends the tail
  and also converts general slowness into a quality regression, so a run with
  `embedding unavailable` in it is telling you about latency first.

#### What `--scale` actually measured, and what it corrected (2026-09-10)

**Put the distractors in the partition under test, or the instrument lies.**
The first implementation wrote them as `source_type='documents'`, which reads
plausibly and tests nothing here: this team is 20 072 records, 118 documents,
27 episodes, 9 memories, and the semantic arm filters
`source_type IN ('memories','episodes','records')`. Ten thousand document
distractors left the knowledge partition at 20 108 rows — the arm moved 747 ms
to 769 ms, 3 % for a 49 % bigger TABLE — so a `--scale 50000` run would have
reported a healthy arm while the arm never grew. They are `records` now.

Re-measured with the distractors in the right place, 10 repeats either side:

| stage (p50)                              | 20 108 knowledge rows | 30 108 |      Δ |
| ---------------------------------------- | --------------------: | -----: | -----: |
| knowledge-arm `semantic`                 |                476 ms | 566 ms | +18.9% |
| other arms `semantic` (118 rows, 6 rows) |                259 ms | 256 ms |   flat |
| `rerank`                                 |                271 ms | 273 ms |   flat |
| whole suite                              |                 23/23 |  23/23 |      — |

**A +50 % partition costs +19 %, not +50 %, and the second row says why.** An
arm scanning 118 rows still takes 259 ms, so the measured `semantic` stage is
roughly **255 ms of fixed cost plus the scan**. Back out the fixed part and the
scan alone goes 221 ms → 311 ms for 1.50x the rows: linear, as expected. The
fixed part is the transaction `runSemanticSearch` needs for `SET LOCAL` —
BEGIN / set_config / SELECT / COMMIT is four round trips, and this dev database
sits behind ~32 ms of RTT (~128 ms), plus planning and 150 rows of transfer.

**Consequence for the Phase 1 gate, and it is not a small one: `[hybrid]
semantic p50 <= 20 ms` is not reachable on this topology and never was.** 20 ms
is the SERVER execution time an `EXPLAIN` reports; the client-observed stage
cannot go below its own round trips. After HNSW the realistic dev figure is
~265 ms (fixed cost + a single-digit scan), and the two converge only in prod,
where the database is not behind a tunnel. State the gate as a server-side
`EXPLAIN` number OR as a dev-topology target, and never compare one to the
other — that mistake reads as "HNSW did not work" on a change that worked.

**Instrumentation gap, still open:** `[hybrid]` does not name its arm, and
`searchRAG` fires three per turn (n=690 for 230 turns), so pooling them puts a
20 000-row query and a 118-row query in one distribution and the p50 describes
neither. The knowledge arm is currently identifiable only because it is the one
that also runs the registry arm — grep `\[hybrid\].*registry=`. Label the line.

Escalation reproducing at exactly 43.5 % against the earlier independent
measurement is the useful cross-check here: the routing rule is stable, so a
change in it later will be a change, not noise.

### CLOSED: the HNSW index is used (2026-09-10)

Kept in full because the diagnosis that stood here for a day was **wrong**, and
the way it was wrong is the reusable part.

**What it said.** `cosine_distance(halfvec, halfvec)` ships at `procost = 1`, so
Postgres prices 20 000 distance computations over 2 560 dimensions like 20 000
integer additions, values the index at 97 730 against the Seq Scan's 3 310, and
never picks it. Fix: a migration raising the operator cost.

**What is true.** The lever is `hnsw.ef_search`, not the operator cost. Measured
at 20 108 rows with the plan asserted from `EXPLAIN` at every point:

| `ef_search` | procost = 1 | procost = 100                      |
| ----------- | ----------- | ---------------------------------- |
| 100         | Seq Scan    | parallel Seq Scan (`Gather Merge`) |
| 160         | Seq Scan    | —                                  |
| 200         | **HNSW**    | **HNSW**                           |
| 400         | **HNSW**    | **HNSW**                           |

The index was unused because `HNSW_EF_SEARCH` was **100 while the arm asks for
`PER_SEARCH_LIMIT = 150` rows**. The planner will not choose a scan that cannot
fill the limit, whatever the operator costs — and at ef=100 the migration's only
measured effect was to buy a parallel worker for the same exhaustive scan. The
migration was deleted, not deferred.

Two caveats that keep this honest. The earlier reading that procost flipped the
plan was taken on a corpus carrying 10 000 `--scale` distractors, and at 30 108
rows it did flip it — both knobs push the same thin margin. And deleting those
distractors triggered the table's first `autoanalyze` in a long while, so fresh
statistics are part of why the plan looks the way it does now. **Re-check the
plan after any bulk change to `ai_vectors`**, and treat a margin this thin as
something to observe rather than to rely on. That is what the runtime famine
guard is for.

#### Does the index cost precision? Measured, not argued

HNSW is approximate where the Seq Scan was exact, so this is a real question and
an `EXPLAIN` cannot answer it. Ten real eval questions, 20 108 rows, each HNSW
result diffed against the exact answer, each plan asserted:

| `iterative_scan` | ef  | rows/150   | recall@20 | recall@150 | RRF mass | ms  |
| ---------------- | --- | ---------- | --------- | ---------- | -------- | --- |
| off              | 40  | **32/150** | 97.5 %    | 21.5 %     | 66.2 %   | 39  |
| off              | 100 | **87/150** | 98.0 %    | 58.2 %     | 86.8 %   | 54  |
| off              | 400 | **67/150** | —         | —          | —        | 50  |
| `strict_order`   | 100 | 150/150    | 98.0 %    | 87.7 %     | 94.7 %   | 46  |
| `strict_order`   | 200 | 150/150    | 100 %     | 95.1 %     | 98.3 %   | 52  |
| `strict_order`   | 400 | 150/150    | 100 %     | 98.1 %     | 99.4 %   | 62  |
| `strict_order`   | 800 | 150/150    | 100 %     | 99.7 %     | 99.9 %   | 70  |

against 225 ms for the exact answer. "RRF mass" is the share of the semantic
arm's fusion weight `SEMANTIC_WEIGHT/(rank+1)` recovered — the metric that
matters, because a row missed at rank 150 is worth a fiftieth of one missed at
rank 1. Shipped: **ef=400, `strict_order`**.

Read it as two independent knobs. `ef_search` decides WHICH rows come back;
`iterative_scan` decides HOW MANY, and only the second keeps its guarantee as
the corpus grows. The `off` rows are the reason they ship together: ef=400
alone would have cut the arm to 67 of 150 candidates, silently.

The top of the ranking — all that survives fusion and rerank — is exact from
ef=200 up, which is why this is not a precision-for-speed trade.

#### Three ways this measurement lied first

All three produced clean-looking tables. Anyone re-measuring should expect them:

- **`SET LOCAL enable_seqscan = off` does not force the index.** The planner
  answers with a Bitmap Heap Scan plus a Sort, which is EXACT — so the
  "approximate" arm was the exact arm and every recall figure was 100 %.
  Forcing HNSW takes three switches: no seq scan, no bitmap scan, **and no
  sort**.
- **A probe that does not assert its own plan is not a measurement.** The
  earlier claim that raising `ef_search` "never changes the plan CHOICE" came
  from a probe where the choice had already been forced.
- **`--scale` distractors are 10 000 perturbations of 16 base vectors.** That
  is a corpus of 16 dense clusters, not production geometry. Numbers taken on
  it happened to match the clean corpus here — check, do not assume.

The selective arms are unaffected and must stay that way: `documents`
(118 rows) and `workflows+pages` keep `idx_ai_vectors_source`, exact, at every
`ef_search` and every operator cost tested.

Two operational facts worth carrying: the HNSW index is **238 MB against a
128 MB `shared_buffers`**, and it did **not** shrink from 167 MB when the
10 000 distractors were deleted — HNSW reclaims that only under `REINDEX`. Any
latency figure taken between a bulk delete and a reindex is pessimistic.

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

15 cases (`evals/cases/memory-recall.ts`), through the real turn, over the SAME
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

#### The contextless cases — the only shape a standing layer can answer (added 2026-09-11)

`mr-contextless-status` ("Où on en est ?"), `mr-contextless-brief` ("Fais-moi
un point."), `mr-contextless-week` ("Qu'est-ce qu'on a de prévu cette
semaine ?").

Every other case in the suite hands retrieval an entity to match on. These hand
it a pronoun. **Retrieval is query-shaped by construction**, so whatever answers
here came from a block that is present WITHOUT having matched — which is the
only claim a standing-memory layer makes, and the suite had no case for it. The
layer was built, shipped and argued about for a week with nothing that could
tell it apart from its own absence; `--standing-mode none` is the control that
now can.

Two things make them measure that and not something else:

- **The fixtures are dated relative to now.** They used to be frozen in June
  2026 (`new Date("2026-06-…")`) and `ensureEpisode` returned early on an
  existing title, so the dates never refreshed once seeded. Any window-bounded
  layer — 30 days here — would have seen an empty universe and the three cases
  would have been unfailable. `daysAgo(n)` throughout, and the ensure now
  re-dates existing rows in place and re-vectorizes when the summary changed.
  `pricingOld` sits at day −48/−45 **deliberately outside** the window: still
  retrievable by the `rec-*` block cases, never in the standing block. A free
  negative.
- **`mr-contextless-week` turns on a COMPUTED date.** One fixture episode
  (`Planning — semaine en cours`, day −1) names the next Tuesday, formatted at
  seed time; the assertion recomputes it from the same `nextDeliveryDate()`
  helper. Nothing else in the universe holds that date, so general knowledge
  cannot produce it.

`mr-private-leak` gates this layer too: the private Sirius episode must not
appear in the standing block either. The block reads
`user_id IS NULL OR user_id = :caller`, the same predicate as recall and
`searchKnowledge` — and it is pinned by mutation in
`shared/tests/integration/episodes/list-standing.test.ts`, where deleting the
clause surfaces another user's row.

**Do not read these three against a fixture team and conclude about a real
one.** The recall fixtures seed at TEAM scope (`userId: null`), whereas
`distillConversation` writes a PRIVATE episode whenever a conversation has one
participant — so on a one-person team, which is every team's first weeks, the
pipeline produces nothing team-scoped at all. The EVAL team therefore
**favours** the `digest` arm, whose inputs are team-scoped only. If it does not
win there it wins nowhere.

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

| Suite                     | Frozen                                                                                                                                                                                                                                                                                                                                                                   | Detail                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `evals:memory` (17 cases) | 16/17 stable at N=10                                                                                                                                                                                                                                                                                                                                                     | flagged `mem-relation-noise` 9/10 re-ran **30/30** → closed. The four once-contested cases, targeted: reanchor 30/30 · merge 30/30 · revise 29/30 · distill-record-activity 30/30                                                                                              |
| `evals:chain` (5 cases)   | ~~4/4~~ → **5/5 at N=10, whole suite, 2026-09-11** — `workflow-turn-one` 10/10 (30/30 targeted), `oneoff-not-durable` 10/10, `convention-promoted` 10/10 WITH the Meridian residue present, `contradiction-corrected` 10/10, `decision-survives` 10/10. (`chain-digest` came in `1017fa7` and went with the digest in `9a1c201`; `chain-workflow-turn-one` replaced it.) | `chain-contradiction-corrected` closed by the consolidation-judge id handles                                                                                                                                                                                                   |
| `evals:recall` (23 cases) | 22/23 stable at N=10                                                                                                                                                                                                                                                                                                                                                     | **open residual**: `rec-noise-general` — 8/10 in the freeze, **14/30** targeted (historic ~88 %). Judge-side selectivity against a lexically dominant, non-responsive candidate; the hot-path judge model is deliberately out of scope here. The one case of 44 below the bar. |

**The `evals:chain` row above is out of date as of 2026-09-11**, in both
directions, and the row is left struck through rather than quietly edited
because the stale version was used as a gate:

- the suite went to **5 cases** (`chain-digest`, `1017fa7`), back to **4** when
  the digest was deleted (`9a1c201`), and to **5** again with
  `chain-workflow-turn-one` — the count was never the point, the fact that a
  gate row can go stale between two reads of it is;
- `chain-convention-promoted` went 10/10 → **0/10** → **10/10**. See below.

#### CLOSED: `chain-convention-promoted` was cross-suite contamination (2026-09-11)

The promoter has no defect. Run after `evals:memory -- --cleanup` on the
isolated `eval-write` team: **10/10, `added=1 updated=0 noop=0` on every one of
the ten repeats**, ~20 s per repeat.

What made it 0/10: `evals:memory` left `learned/meridian-bon-de-commande.md`
on the shared team, and `loadExistingLearned` pulls EVERY `learned/%` row into
`<existing_learned>`, whose prompt says "NOOP … or already covered". A residue
about a signed purchase order suppressed a promotion about a signed purchase
order in duplicate. The model was right; it was answering about the wrong
team's leftovers.

Three lessons, all general:

- **A shared fixture team is a silent coupling between suites.** The failure
  appeared in `chain`, the cause was in `memory`, and nothing linked them. That
  is what `EVAL_WRITE_TEAM_ID` and end-of-suite cleanup remove.
- **"Correct inputs, empty output" was not enough to localise it.** The inputs
  WERE correct; the corpus the prompt also carried was not. Log the prompt's
  other half before blaming the model.
- **Isolation is not the fix, only the diagnosis.** A real team will accumulate
  `learned/` files about unrelated subjects, so the promoter's "already
  covered" gate still reads a corpus that grows without bound. P5.1's topic
  filter is what makes it robust, and its acceptance test is this case at
  **10/10 with the residue deliberately present** — run and passed, below.

Three previously-SILENT noop paths in `promoteEpisodes` were made loud while
chasing this — schema rejection, a path outside `learned/`, an empty list.
Each one used to return "nothing to promote", which is indistinguishable from
a correct decision not to promote. A pipeline stage that cannot tell you it
failed will eventually be measured as if it succeeded.

#### The dedup gate now reads only same-subject memories (P5.1, 2026-09-11)

**Result: `chain-convention-promoted` 10/10, `added=1 updated=0 noop=0` on
every one of the ten repeats, ~15 s each, with `learned/meridian-bon-de-commande.md`
deliberately left in place** (seeded by `evals:memory -- --case mem-promote-dedup
--repeats 1 --keep`, and verified still present in `ai_memories` after the run).
That is the configuration that scored 0/10.

`chain-oneoff-not-durable` was re-run for the same reason and is **10/10,
`added=0` on every repeat**: the residue used to sit in ITS block too, so a
case that passes by NOOPing had to be re-measured once the thing it might have
been leaning on was taken away. It was not leaning on it.

What changed, in `loadExistingLearned`: the gate reads the `learned/` memories
about the RECORDS this cluster anchors on, not the namespace. A promotion
stamps `Sources: episode:<uuid>` on what it writes, so a stored fact's subject
is recoverable — resolve its cited episodes back through `ai_episode_records`
and keep the ones that overlap. No prompt change: the model was never the
problem, the corpus it was handed was.

Three things worth keeping:

- **The fallback is EMPTY, never "all."** A memory citing nothing resolvable
  is dropped. "All" is the behaviour being fixed, so it cannot also be the
  safe default — the cost of dropping one is a duplicate under a new path, the
  cost of keeping all is the promotion that never happens.
- **Cut topically, then by recency — never the other way.** The read window is
  100 rows, the prompt budget 20. Ordered by recency and cut at 20 FIRST (as
  the plan originally specified), a team with a hundred `learned/` files loses
  the memory about this very subject and the gate re-adds a duplicate of
  itself. An integration test pins exactly that case.
- **A fixture that fakes a field is a lie the day that field becomes
  load-bearing.** `mem-promote-dedup` seeded its "already stored" memory with
  `Sources: episode:seed`. Harmless while nothing read it; the moment the gate
  did, the fixture was seeding a memory the gate is RIGHT to ignore, and the
  case would have failed for the correct reason. It now builds its episodes
  first and cites their real ids — which also makes the acceptance test above
  harder, since the residue carries three real, resolvable ids pointing at the
  wrong subject rather than an unparseable string.

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

### A workflow run's memory rides turn 1 (2026-09-11)

Until now a run got `<active_memory>` on turn 1 and nothing else — while
`assembleContextFragments` built the memory index and the standing block on
EVERY turn and discarded both. Two queries per turn of every run, for output
nothing consumed.

The run now gets all three in its turn-1 steering message, and
`memory: isFirstTurn` skips the reads from turn 2 on. They persist by history
replay, which is the same reason recall already rode there: the workflow system
prompt must stay byte-stable for a whole run, so anything per-run in it breaks
the provider cache on every turn of every other run.

**The index is the one that matters here**, and it is worth being explicit
about why, because "give the run more memory" is not the reason. A workflow
executes a REPEATABLE PROCESS. Recall is query-shaped and matches against
`${workflow.name}\n${playbook.goal}` — a short, generic string. A team's
written-down process for that exact job is precisely what such a string fails
to retrieve, and `<memory_index>` matches nothing by construction: it lists
every path.

Worst case on turn 1: the index self-caps at 80 files, the standing block at
600 tokens, recall at 2 400 chars — about +1.5k tokens, once per run.

What pins it: `tests/unit/agents/playbook-block.test.ts` (turn 1 carries both,
turn 2 neither) and `tests/unit/agents/fragments-memory.test.ts`, which asserts
on CALL COUNTS with a positive control — an assertion on the returned block
would pass just as well against a version that does the work and throws the
answer away, which is the bug that was there before.

Still thrown away on the workflow path and out of scope here:
`recall.capabilityBlock` — one rerank per run for nothing.

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
