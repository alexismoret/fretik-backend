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
bun run evals                                                               # local JSON/MD report, no Langfuse
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
