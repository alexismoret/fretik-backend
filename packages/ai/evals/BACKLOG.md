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

## Not eval-expressible (unit-tested instead)

- **Mid-stream provider death (2026-07).** The CBAM-translation session died twice on an
  OpenRouter mid-stream provider error (a plain-object `{ code, message }` frame), which the
  classifier mislabelled `fatal/unknown` and logged as `[object Object]`. This failure mode
  cannot be injected through the real-service eval harness (no provider-failure seam), so it
  is covered by `tests/unit/lib/stream-errors.test.ts` (classification + `describeStreamError`
  serialisation) rather than a dataset case. The behavioural half of the same incident — the
  24-python-call authoring reflex — IS eval-expressible and lives in `cases/transform.ts`.

- **Attachment visibility across turns (2026-07).** A file the active profile cannot ingest
  natively is dropped from the message history, so `<file_attachments>` is the only thing
  that keeps it knowable; while that block was built from the LAST USER MESSAGE only, every
  earlier attachment vanished on the next turn and the agent reported having no files.
  Fixed by moving chat to `buildConversationAttachedFilesBlock`. Not eval-expressible: a
  case is one `/invoke` turn, and `fixtures` always attaches to that same seeded message, so
  the harness cannot produce "file attached on turn 1, asked about on turn 2". Covered by
  the wiring in `handlers/chatbot.ts` instead. Making it a dataset case
  needs multi-turn support in `conversation-lifecycle.ts`.

- **The whole workflow path (2026-07).** The engine runs the CHATBOT only — there is no
  workflow-run case, and a run is where the expensive failures happen. Two shipped and went
  unnoticed for days: `extract` failing 25/25 on `INVALID_SCHEMA` (18-23/07), then
  `pages: ""` failing 13 of 38 calls on the first attempt of every run (27/07). Both are
  now unit-tested (`tests/unit/tools/extract.test.ts`), but the class of defect —
  "the executor's tool calls in a real run" — has no coverage. Needs a headless
  `POST /workflow/turn` seam in the harness plus a fixture playbook; until then, a workflow
  change is validated by replaying a real run and reading the trace.

  **What the gap cost on 2026-07-28**, a run where every tool behaved correctly: the
  playbook itself decided to withhold the deliverable, paraphrased the example file's header
  into a column that does not exist, and spent 45% of the run authoring a string-similarity
  scorer. The fixes are doctrine (`platform-guide/references/workflows.md`, the `create_draft`
  description, one `<tool_routing>` row) and only the LAST of them is eval-expressible from a
  chat turn — `doc-match-is-judgement`. "A run always produces its deliverable", "copy the
  example's structure, don't describe it", and "an example output built from the example
  inputs is a worked answer" are properties of a PLAYBOOK, and the harness cannot author or
  execute one. They stay verified by replaying a real build-and-run conversation.

- **`page-narrative-report` and `page-dry-run-is-the-probe`, removed 2026-08-16.** Cut when
  the pages suite grew from 10 to 14 cases and every case in it now costs a real page build
  (3-7 min, ~$0.12), so a case has to earn its slot rather than merely pass.

  `page-narrative-report` asserted that a "write me a short report" ask produced a heading or
  a paragraph and a table. Nothing else in the suite can fail that assertion without also
  failing `page-dashboard-kpi-charts`, and no shipped defect ever looked like it — a floor of
  "some prose exists" is not a quality gate, it is a smoke test of the compiler.

  `page-dry-run-is-the-probe` measured the trajectory doctrine (probe with `dry_run`, not
  `querySql`). Its subject MOVED: pages route to the `buildPage` sub-agent, whose tool calls
  never reach the parent turn's SSE stream, so the assertion could only ever report "no SQL
  where I can see". Keeping a check that cannot observe its own subject is worse than not
  having it — it reads green for the wrong reason. Its structural half duplicated the
  dashboard case. **To bring it back**, the harness needs to read a sub-agent's calls (the
  `.page` Langfuse sub-trace, or a tool-trace channel on the invoke response); the doctrine
  itself is meanwhile visible as cost-per-turn on the run.
