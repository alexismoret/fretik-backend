# Eval backlog — failure modes removed in the Langfuse-only cleanup

## 2026-07-17 review (post prompt-refonte) — 4 case removals + tiering

Full audit of the 76 curated cases against the refonte doctrine. Removed (recover
from git history at the commit before this review; `langfuse:sync-datasets` now
ARCHIVES the decurated dataset items, preserving old run comparability):

- **`edge-empty-corpus`** — near-duplicate of `rag-no-match` (same failure mode:
  fabrication on a no-match lookup; both judge-graded). `rag-no-match` (smoke) keeps
  the coverage.
- **`lat-sql-simple`** — the last case of the `latency-stress` suite (deleted);
  its 30s ceiling moved onto `multi-no-overkill` (`latencyUnder`), which asks the
  same simple-count question. Per-trace latency stays in Langfuse.
- **`tp-vision-image`** — duplicate of `mm-image-scene-qa` since C5 made it
  answer-graded (same fixture, same rubric intent). The multimodal suite owns
  visual-answer accuracy.
- **`dispatch-no-recursion`** — probed a REGISTRY invariant (sub-agent toolset
  excludes `dispatchAgent`) with an expensive multi-dispatch e2e turn. Replaced by
  the deterministic unit test `tests/integration/agents/sub-agent-registry.test.ts`.

Same review: cases were split into **core** vs **`tier: "model-gate"`**
(see `curation.ts` + RUNBOOK "Run tiers") so the everyday baseline runs ~45 cases
instead of 76; stale `listEntities` references and the last industry-flavoured
prompts (`BL-…` identifiers) were rewritten; the orphaned DAE fixture sidecar was
deleted and `fixtures/README.md` rebuilt from actual usage.

The harness is now **Langfuse-only**: `evals/run.ts` runs the curated cases as a
`chatbot-eval` dataset run; there is no local JSON-report path. The gold set grows
from production failures via `promoteTrace` (see `RUNBOOK.md`), not from synthetic
fixtures.

In that cleanup we deleted ~70 non-curated synthetic cases (4 triaged DROP + the rest
deferred-but-unrunnable once the local runner was removed). The 20 curated cases that
remain are the fixture-free / seed-free smoke set in `curation.ts`.

**Recovering any deleted case:** they live in git history at the commit before the
cleanup (`git log --oneline -- evals/cases/`); restore a file or copy a case object
from there. This file records WHAT coverage we had so error-analysis on prod traces
knows which failure modes to re-derive as real `origin:prod` cases.

## Failure modes the deleted cases covered (re-grow from prod, by capability)

High regression value (triaged KEEP, blocked on a real doc/seed — recreate from prod):

- **Extraction (tabular)** — `tabular-extraction.ts`: row-count completeness (every row,
  not a subset), literal value preservation (French number locale, em-dash, currency
  suffix, mixed-format IDs), parse-vs-transcribe on multi-page PDFs, anti-trigger on prose
  requests. Highest-value gap; recreate from a real uploaded spreadsheet/PDF.
- **File reading** — `file-attachments.ts`: PDF→OCR-sidecar read, image OCR vs `vision`
  routing, oversized-file pagination, vision-rejects-plain-text. Recreate from real uploads.
- **Compaction** — `compaction.ts`: no-422 over a long history, micro-compaction clears old
  turns, filename preservation. Needs a seeded long conversation history.
- **SQL analytics** — `sql-analytics.ts`: counts/group-by/joins with schema context, dynamic
  `document_field_values` filters. Needs schema fixtures or real team data.
- **Memory (seeded)** — `memory.ts` / `auto-memory.ts`: team-vs-user scope, write-fact,
  proactive save triggers. Needs a pre-seeded memory store.

Lower value (triaged REWRITE — loose rubric / contextless prompt) or DROP (trivial): the
remaining `ask-user`, `vague-prompts`, `parallel-tool-calls`, and the trimmed cases in
`rag-*`, `edge-cases`, `latency-stress`, `multi-step`, `bash-execution`, `dispatch-agent`,
`simple-qa`. Most need a sharper rubric before they're worth re-adding; prefer deriving the
equivalent from a real prod failure.

## C11 review (2026-06-12) — additive, no removals

The eval-overhaul (C11) reviewed the curated set for redundant/artificial cases before
adding. Decision: **additive only — nothing removed.** After the C3 (model-gate) and C6
(error-analysis) passes the 49-case set is already tightly curated; no case read as
redundant or artificial enough to drop without losing a real signal (the 3 `par-*`
parallel probes are intentionally informational, not redundant). C11 instead **added** the
8-case `b2b-efficiency` suite (realistic generalist office tasks) and a layer of
INFORMATIONAL tool-calling **efficiency** scores — so "the bot worked badly/slowly" is now
caught by metrics on the existing trajectories, not by manufacturing more cases (which the
guardrail below discourages). If a future pass does drop a case, record it here.

## Method to re-add (do NOT bulk-restore)

When prod error-analysis names a real failure: `promoteTrace` the failing trace into the
dataset (`origin:prod`), or hand-write one tight case grounded in that trace, add it to
`curation.ts`, and `bun run langfuse:sync-datasets`. One real, sharp case beats ten
synthetic ones.
