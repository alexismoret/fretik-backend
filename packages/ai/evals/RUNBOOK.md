# Evals runbook — how to check evals & what to run when

The chatbot eval is **one engine** (this `evals/` harness, runs the REAL chatbot
end-to-end) invoked from **three surfaces**, each with a distinct job.

| Surface           | Who / when                   | Job                                                                                                          |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Scripts (dev)** | You, by hand, after a change | "Did my change help?" — run the cases, score, push a dataset-run                                             |
| **CI**            | Automatic on PR + nightly    | Same engine, with a threshold — PR smoke gate blocks regressions, nightly = full                             |
| **Langfuse UI**   | You, to analyse              | Compare dataset-runs, read per-capability scores, drill into a failing trace. NOT a runner for offline evals |

Separately: the **managed online evaluator** (configured in the Langfuse UI) runs
continuously on **prod** traffic, sampled — quality monitoring, not the dataset loop.

## Day-to-day (scripts)

Needs a **live `@fretik/ai` service** and `AI_SERVICE_URL` (it is NOT in `.env` — pass it inline):

```bash
cd backend/packages/ai
# 1. start the service in another pane (dev DB): bun run dev   (or ../../dev.sh)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse                 # full baseline (20 cases)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --smoke      # PR smoke subset (~8)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --capability external-actions
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --deterministic-only   # no judge (free of judge cost)
AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse -- --run-name <name>      # explicit dataset-run name
```

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

## Cost

Every model call bills **OpenRouter**, on every surface. The difference is **bounded/on-demand**
(scripts, CI — you trigger them on a finite set) vs **continuous/automatic** (the online rule,
once enabled, judges a sample of every prod turn forever).

Each `evals:langfuse` run attaches **`cost-agent-usd`** (total) + **`cost-per-turn-usd`** to the
dataset run — the exact agent cost per turn, summed from each turn's server `chatbot-turn` trace
(`api.trace.get(...).totalCost`, via the captured `langfuseTraceId`; the comment shows coverage
`N/M turns costed`). Compare these across runs to weigh agent models for the Phase 8 decision.
The in-process **judge** cost is not yet rolled in (constant across agent-model comparisons; a
follow-up).

## Methodology guardrails (do not violate)

- **Failure taxonomy is DISCOVERED, never seeded a priori** — a pre-defined list causes
  confirmation bias, and score configs cannot be deleted. It comes from error analysis
  (open-code ~30-50 prod traces → cluster), gated until prod traces exist. The seeded
  configs are only objective metrics (`correctness`, `pass-rate`, `no-error`, `latency-ok`);
  `failed-check` is a mechanical "which assertion broke" label, not the taxonomy.
- **Synthetic cases are a seed, not the gold set** — the real dataset grows from prod failures.
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
4. **CI secrets/vars** (GitHub repo settings) for `.github/workflows/langfuse-experiment.yml`:
   `LANGFUSE_*` creds as **secrets**, dataset/project IDs + URLs as **vars**. PR-blocking gate
   (service-in-CI) is still a follow-up — the workflow is non-blocking today.
5. **Push + deploy.** Once 3–4 are done: `git push origin main` → build the single Docker image →
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
5. **Phase 8 — model strategy, data-driven**: compare agent models (MiniMax M2.7 vs DeepSeek V4 Pro
   vs others) on the grown dataset (correctness/capability + cost-per-turn + latency). Mechanism:
   swap `OPENROUTER_CHAT_MODEL`, restart, `evals:langfuse --run-name <model>`, compare in the UI.
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
