# Evals runbook — how to check evals & what to run when

The chatbot eval is **one engine** (this `evals/` harness, runs the REAL chatbot
end-to-end) invoked from **three surfaces**, each with a distinct job.

| Surface           | Who / when                           | Job                                                                                                                                       |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Scripts (dev)** | You, by hand, after a change         | "Did my change help?" — run the cases against your dev service, score, push a dataset-run. THE primary surface.                           |
| **Manual CI**     | You, on demand (`workflow_dispatch`) | Same engine, triggered from a runner against a reachable, data-bearing service you pass in (`ai_service_url`). NOT a PR gate (see below). |
| **Langfuse UI**   | You, to analyse                      | Compare dataset-runs, read per-capability scores, drill into a failing trace. NOT a runner for offline evals                              |

Separately: the **managed online evaluator** (configured in the Langfuse UI) runs
continuously on **prod** traffic, sampled — quality monitoring, not the dataset loop.

**Why evals are NOT a PR gate** (`langfuse-experiment.yml` is `workflow_dispatch`-only):
the curated cases drive a LIVE `@fretik/ai` AND assume the target team's real data
(counts, documents, entities), so they can't run against a fresh CI database; a CI
runner can't reach your local dev; and evaluating a PR against any _external_ deployed
service would test the deployed code, not the PR. PR quality gating (typecheck / lint /
test + image build) lives in `ai.yml`. Run evals locally against dev before merging
(below). The manual workflow is for triggering a run from CI against a reachable,
data-bearing service you specify — never prod (it spends on the prod account and emits
`env=production` traces that pollute prod analytics).

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

**Model pinning.** Every `evals:langfuse` run pins the turn model via
`X-Model-Profile-Key` — default = the CODE `chat` binding in
`src/lib/model-registry/profiles.ts` (the flagship held to 1.000), overridden by
`--candidate <profileKey>`. Without the pin, the EVAL team's C8 picker choice
silently overrides the code binding (the 2026-07-17 runs measured `gpt-oss-20b`
that way). The `evals:memory` / `evals:recall` harnesses are separate and keep
their own gpt-oss-20b/120b defaults (`--profile` / `--judge-profile`).

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

Every change of a model-registry binding (`src/lib/model-registry/profiles.ts`) goes
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
   writes `profiles.ts`** — commit the `evalGate` stamp + the role-binding flip in ONE
   reviewed PR. The PR is the promotion.
5. After the flip deploys: run a full `evals:langfuse` on the new default as the fresh
   baseline.

**Pass criteria** (envelopes in `evals/langfuse/gate-config.ts`, env-overridable):
per-capability correctness drop ≤ 1 case-equivalent (ADVISORY by default — see below) ·
`tool-call-validity` ≥ baseline − ε · `zombie-rate` ≤ baseline + ε · `cost-per-turn-usd`
within the profile's `costClass` envelope (ADVISORY until calibrated) · avg latency ≤ 1.5×
baseline · ≤ 1 candidate case answered by the fallback agent (`fallback-served` — a silent
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
`ROLE_BINDINGS.chat` / `.workflow` requires the bound profile to carry
`evalGate.status: "passed"`, enforced by `tests/unit/lib/model-registry.test.ts` — so a PR
that swaps the default without a gate run fails CI.

```bash
cd backend/packages/ai           # service running in another pane
AI_SERVICE_URL=http://localhost:8083 bun run evals:gate -- --candidate gpt-5.6-luna
```

Then commit the printed `evalGate` stamp onto that profile **and** repoint the binding, in
the same reviewed PR.

### Adding a model to the catalog (no gate needed)

1. Read its facts from OpenRouter (`architecture`, `supported_parameters`, `pricing`,
   `reasoning`) and write them into `catalog` verbatim — `bun run models:check` diffs them.
2. Set `assessment.enabled`: today's rule is `false` for anything costlier per turn than
   GPT-5.6 Luna @xhigh, with a `disabledReason` so the hub can explain itself.
3. Add `aaSlug` — pinned to the profile's `reasoning.defaultLevel`, since Artificial
   Analysis publishes one record PER EFFORT LEVEL and they differ a lot (Luna spans 33.3 to
   51.2 intelligence across five levels).
4. Add `verbosity` from AA's `intelligenceIndexOutputTokensPerTask`. This is site-only data,
   absent from the v2 API, so it is hand-curated — and it is load-bearing for `costLevel`,
   because models differ ~20× in output volume and headline price alone mis-ranks the fleet
   by up to 8 positions.
5. Activate `nativeInput` for every visual modality the catalog allows (`audio` stays off
   registry-wide until a call site produces audio parts).
6. Add the brand name to `lib/model-registry/display.ts` and a `FALLBACK_METRICS` row.
7. Verify: `bun run check && bun run test && bun run models:check --probe`.

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
dataset run — the exact agent cost per turn, summed over the observations of each turn's server
`chatbot-turn` trace (`api.observations.getMany({ traceId, fields: "usage" })`, via the captured
`langfuseTraceId`; the comment shows coverage `N/M turns costed`). Compare these across runs to
weigh agent models for the Phase 8 decision.
The in-process **judge** cost is not yet rolled in (constant across agent-model comparisons; a
follow-up).

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
  `COUNT(*)` query, or asserting `searchKnowledge` when a structured `listObjects`/`querySql`
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
   deploy via Dokploy. DB migrations run automatically on container boot (advisory-locked).

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
   longer exist; bindings live in `src/lib/model-registry/profiles.ts` and flip via a reviewed PR.
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
