# Eval backlog — failure modes removed in the Langfuse-only cleanup

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

## Method to re-add (do NOT bulk-restore)

When prod error-analysis names a real failure: `promoteTrace` the failing trace into the
dataset (`origin:prod`), or hand-write one tight case grounded in that trace, add it to
`curation.ts`, and `bun run langfuse:sync-datasets`. One real, sharp case beats ten
synthetic ones.
