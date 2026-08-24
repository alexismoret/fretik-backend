/**
 * Curated eval cases — the output of the triage HUMAN GATE
 * (`scripts/triage-eval-cases.ts` → review). Maps `caseId` → its
 * capability + whether it is in the PR smoke set.
 *
 * Only cases listed here sync to the Langfuse `chatbot-eval` dataset
 * (`evals/langfuse/dataset-sync.ts`); everything else is excluded. This
 * is the SINGLE source of curation — no scattered per-case edits.
 *
 * Scope (2026-06-02, first pass): the 20 keeps that need NEITHER a file
 * fixture NOR a DB seed — robust to run against the dev eval environment.
 * DEFERRED: fixture-bound cases (file-tabular-*, synthetic non-realistic
 * documents → replace with real prod docs via `promoteTrace`) and
 * seed-DB cases (memory/compaction). These synthetic cases are a SEED to
 * prove the loop + a minimal smoke gate; the real gold set grows from
 * production failures. Extraction is intentionally thin here (1 case) —
 * its strong cases are fixture-bound and wait for real documents.
 *
 * NOTE (session 8): we trialled curating 5 fixture-bound extraction cases
 * here, then reverted — the heavy multi-doc case (36-page DAE OCR) made
 * runs too long, and the decision was to grow extraction from real prod
 * documents via `promoteTrace` rather than synthetic fixtures.
 */

import type { Capability } from "./types";

export interface CuratedCase {
  capability: Capability;
  /** In the PR smoke set (~2 per capability). */
  smoke?: boolean;
  /**
   * Run tier. Omitted = CORE: behavioral regression cases that run on
   * every full `evals:langfuse` baseline (prompt / tool / harness
   * changes). `"model-gate"` = per-MODEL probes (BFCL/IFEval-style
   * mechanics, long-context, native multimodal) that measure the model,
   * not the system prose — excluded from the default full run, included
   * with `--all` and in every `evals:gate` model-promotion run.
   * `--smoke` / `--capability` select across BOTH tiers explicitly.
   */
  tier?: "model-gate";
}

export const CURATED: Record<string, CuratedCase> = {
  // extraction (7)
  "rag-specific-id": { capability: "extraction", smoke: true },
  "file-pdf-read": { capability: "extraction", smoke: true },
  // Structured-extraction chantier (2026-07): the `extract` tool replaces
  // ad-hoc python parsing on documents. Light fixture (invoice.pdf) —
  // heavier real-document cases still grow via promoteTrace.
  "ex-pdf-line-items": { capability: "extraction", smoke: true },
  "ex-record-header-fields": { capability: "extraction" },
  "ex-extract-not-python": { capability: "extraction" },
  // Smoke: the read-then-python relapse is the one that reached prod.
  "ex-extract-after-read": { capability: "extraction", smoke: true },
  // Smoke: a non-native attachment (CSV) is invisible in the message; prod
  // 2026-07-27 invented a column header rather than opening the file.
  "file-non-native-header": { capability: "extraction", smoke: true },
  // generation (3)
  "edge-unicode-identifier": { capability: "generation", smoke: true },
  "qa-clarify": { capability: "generation", smoke: true },
  "qa-generalist-offtopic": { capability: "generation" },
  // external-actions (8) — lat-sql-simple folded into multi-no-overkill
  // (latencyUnder), dispatch-no-recursion replaced by the deterministic
  // unit test tests/integration/agents/sub-agent-registry.test.ts.
  "bash-description-field": { capability: "external-actions" },
  "bash-list-workspace": { capability: "external-actions", smoke: true },
  "bash-no-network": { capability: "external-actions" },
  "dispatch-explicit-instruction": { capability: "external-actions" },
  "file-cross-conv-isolation": { capability: "external-actions" },
  "mem-refuse-team-opinion": { capability: "external-actions" },
  "rag-metadata-entity-only": { capability: "external-actions", smoke: true },
  "rag-metadata-excel-summary": { capability: "external-actions" },
  // reasoning (5) — edge-empty-corpus dropped (near-duplicate of
  // rag-no-match: same fabrication-on-no-match failure mode).
  "dispatch-multi-source-synthesis": { capability: "reasoning" },
  "dispatch-trivial-skip": { capability: "reasoning" },
  "multi-no-overkill": { capability: "reasoning", smoke: true },
  "qa-greet": { capability: "reasoning" },
  "rag-no-match": { capability: "reasoning", smoke: true },
  // ── Doctrine probes (2026-07-17 prompt refonte) — pin the refonte's
  // target behaviors: one-python-call, skill gate, RAG-vs-download
  // routing, judge-don't-score, plain language, proactive etiquette.
  // See cases/doctrine.ts.
  "doc-python-one-call": { capability: "tool-use" },
  "doc-skill-first-xlsx": { capability: "tool-use" },
  "doc-rag-first-content": { capability: "tool-use" },
  // Smoke: a run spent 45% of its wall-clock authoring a fuzzy-match scorer
  // for pairs a reader settles instantly (prod 2026-07-28).
  "doc-match-is-judgement": { capability: "reasoning", smoke: true },
  "doc-plain-language": { capability: "instruction-following", smoke: true },
  "doc-proactive-workflow": { capability: "reasoning" },
  "doc-proactive-memory": { capability: "reasoning" },
  // ── transform tool routing (2026-07): a document-scale translation must
  // route to `transform`, not python-authored literals; trivial text stays
  // inline. See cases/transform.ts. CORE tier (measures the prose + tool
  // system, not the model); not smoke — the large-doc case runs multi-chunk.
  "transform-translate-large-doc": { capability: "tool-use" },
  "transform-not-for-trivial-text": { capability: "tool-use" },
  // ── C3 model-gate suites (2026-06-11) — written against OUR tools,
  // method borrowed from public benchmarks (BFCL / IFEval / LongBench),
  // never imported data. See evals/cases/{tool-portability,
  // instruction-following,long-context}.ts. All `tier: "model-gate"`:
  // they measure the MODEL's mechanics, not the system prose — run at
  // model promotions (`evals:gate`) and with `--all`, not on every
  // prompt-change baseline. tp-vision-image removed (duplicate of
  // mm-image-scene-qa since C5 made it answer-graded).
  // tool-use (13 — incl. 3 informational `parallel` probes)
  "tp-sql-quoting": { capability: "tool-use", smoke: true, tier: "model-gate" },
  "tp-sql-aggregate": { capability: "tool-use", tier: "model-gate" },
  "tp-python-multiline": {
    capability: "tool-use",
    smoke: true,
    tier: "model-gate",
  },
  "tp-read-offset": { capability: "tool-use", tier: "model-gate" },
  "tp-xlsx-python": { capability: "tool-use", tier: "model-gate" },
  "tp-memory-view": { capability: "tool-use", tier: "model-gate" },
  "tp-searchtools-activation": { capability: "tool-use", tier: "model-gate" },
  "tp-present-files": { capability: "tool-use", tier: "model-gate" },
  "tp-dispatch-cheap": { capability: "tool-use", tier: "model-gate" },
  "tp-websearch-date": { capability: "tool-use", tier: "model-gate" },
  "par-two-sql": { capability: "tool-use", tier: "model-gate" },
  "par-sql-web": { capability: "tool-use", tier: "model-gate" },
  "par-two-reads": { capability: "tool-use", tier: "model-gate" },
  // instruction-following (8 — incl. 2 `structured-output` probes)
  "if-bullet-count": {
    capability: "instruction-following",
    smoke: true,
    tier: "model-gate",
  },
  "if-forbidden-word": {
    capability: "instruction-following",
    tier: "model-gate",
  },
  "if-uppercase": { capability: "instruction-following", tier: "model-gate" },
  "if-word-limit": { capability: "instruction-following", tier: "model-gate" },
  "if-prefix-suffix": {
    capability: "instruction-following",
    tier: "model-gate",
  },
  "if-no-tools": { capability: "instruction-following", tier: "model-gate" },
  "if-json-only": {
    capability: "instruction-following",
    smoke: true,
    tier: "model-gate",
  },
  "if-json-fenced": { capability: "instruction-following", tier: "model-gate" },
  // long-context (2 — NEVER smoke: long runs, see session-8 note above)
  "lc-deep-retrieval": { capability: "long-context", tier: "model-gate" },
  "lc-multidoc-qa": { capability: "long-context", tier: "model-gate" },
  // ── C10 SQL-tool hardening (2026-06-12) — behavioral security probes.
  // Deterministic guarantees (sanitizer/RLS) live in unit tests; these
  // assert the agent's behaviour. See evals/cases/security.ts.
  // security (3)
  "sec-credential-refusal": { capability: "security", smoke: true },
  "sec-injection-exfil": { capability: "security", smoke: true },
  "sec-member-analytics-positive": { capability: "security" },
  // ── C11 B2B efficiency suite (2026-06-12) — realistic generalist
  // office tasks, each declaring a tool-call budget that feeds the
  // INFORMATIONAL efficiency scores. Correctness assertions stay
  // achievable; the budget measures HOW, not IF. See
  // evals/cases/b2b-efficiency.ts.
  // tool-use (2 — deterministic compute via python)
  "b2b-cdg-csv-total": { capability: "tool-use", smoke: true },
  "b2b-cdg-csv-groupby": { capability: "tool-use" },
  // external-actions (3 — file gen / modify / structured lookup)
  "b2b-compta-csv-deliverable": { capability: "external-actions" },
  "b2b-admin-csv-modify": { capability: "external-actions" },
  "b2b-finance-doc-count": { capability: "external-actions" },
  // generation (2 — summary + email draft)
  "b2b-commercial-doc-summary": { capability: "generation" },
  "b2b-admin-email-draft": { capability: "generation" },
  // reasoning (1 — irrelevance / don't call a tool, BFCL IrrelAcc)
  "b2b-knowledge-no-tool": { capability: "reasoning", smoke: true },
  // ── C5 native multimodal (2026-06-15) — image/video Q&A graded on the
  // ANSWER, not the tool, so the activation A/B (native vs tool-mediated)
  // isolates the multimodal delta. Model probes → tier model-gate.
  // See evals/cases/multimodal.ts.
  // multimodal (4)
  "mm-image-scene-qa": {
    capability: "multimodal",
    smoke: true,
    tier: "model-gate",
  },
  "mm-chart-reading": { capability: "multimodal", tier: "model-gate" },
  "mm-image-plus-text": { capability: "multimodal", tier: "model-gate" },
  "mm-video-qa": { capability: "multimodal", tier: "model-gate" },
  // ── Dynamic-data AI query path (2026-06-20) — the typed-view + links
  // "killer query". Seeds its own object-graph dataset (industry-agnostic),
  // so NOT smoke (needs a DB seed). See evals/cases/object-graph.ts.
  // tool-use (1)
  "graph-killer-query": { capability: "tool-use" },
  // ── Objects autonomy (P8) — proactive object management + the relevance
  // gate. Seeds its own ontology (dedicated throwaway types / labelled company
  // records), so NOT smoke. Graded on the tool trajectory + judge; the
  // partial-update case asserts DB state (no data loss). See
  // evals/cases/objects-autonomy.ts.
  // The three formula cases are the computed-column DECISION, which is one
  // choice with three outcomes: pick it (margin), don't pick it (notes — a
  // formula there is a field nobody can ever type into), and never write to it.
  // objects (12)
  "obj-explicit-create": { capability: "objects" },
  "obj-implicit-create": { capability: "objects" },
  "obj-relevance-gate": { capability: "objects" },
  "obj-propose-schema": { capability: "objects" },
  "obj-partial-update-no-data-loss": { capability: "objects" },
  "obj-rich-create": { capability: "objects" },
  "obj-bulk-csv-import": { capability: "objects" },
  "obj-sql-to-csv": { capability: "objects" },
  "obj-location-create": { capability: "objects" },
  "obj-formula-margin": { capability: "objects" },
  "obj-formula-not-for-entered-values": { capability: "objects" },
  "obj-formula-is-read-only": { capability: "objects" },
  // ── Pages generation (2026-08) — the quality gate `managePage` shipped
  // without. Seeds its own deterministic object type, so NOT smoke. Graded on
  // the STORED definition (structure + the dry-run `warnings` channel of the
  // final write), not the chat reply — every assertion is written to hold for
  // both the nested tree and the flat spec, so this suite is the acceptance
  // criterion for the json-render refonte (≥ baseline). See cases/pages.ts.
  // Consolidated 2026-08-16, 14 cases → 10. The suite had turned PROPERTIES
  // into cases: "did it publish without asking", "did the review loop run",
  // "are the field keys real" are true of ANY page the agent builds, and each
  // was paying a 4-7 minute build to observe one boolean. They are now
  // assertions riding on a case that builds anyway. Nothing lost, ~35% of the
  // wall-clock back. Dropped outright: `page-from-supplied-figures` (its
  // inline-data half is covered by the multi-source case), plus the two cut
  // earlier — see `evals/BACKLOG.md` for both, with what would bring them back.
  // generation (3)
  "page-dashboard-kpi-charts": { capability: "generation" },
  "page-filterable-directory": { capability: "generation" },
  "page-update-preserves-rest": { capability: "generation" },
  // tool-use (1) — a refused write is recoverable from the error text alone
  // (the property that has to survive the weakest model: the hint is the only
  // recovery context there is).
  "page-recovers-from-stale-id": { capability: "tool-use" },
  // reasoning (1) — the relevance gate: no page for a one-off number
  "page-not-for-one-off-question": { capability: "reasoning" },
  // ── Pages v4 (2026-08-16) — the three the structural cases cannot reach.
  // Each RENDERS the stored page in a browser (`evals/page-design-judge.ts`),
  // so each costs ~10s and ~2¢ on top of the turn; that is the price of the
  // only assertions that see what a user sees. Never smoke.
  //
  // generation (2) — expansion of a vague ask into a written brief, and the
  // multi-source page (team records + figures from the message) surviving the
  // mechanical gate.
  "page-vague-request-expands": { capability: "generation" },
  "page-multi-source-gate": { capability: "generation" },
  // ── Page families other than the dashboard (2026-08-16). A suite that only
  // ever asks for dashboards cannot tell a generalist page builder from a
  // dashboard generator — measured: 17 distinct components across 10 generated
  // pages. These ask for a feed, a console and a time axis, carry their data in
  // the message (no seed per theme), and assert the SHAPE rather than the
  // components, which would teach the test.
  // generation (3)
  "page-thread-shape": { capability: "generation" },
  "page-console-shape": { capability: "generation" },
  "page-time-shape": { capability: "generation" },
  // ── SIZE (2026-08-21). Every case above is a page that fits one answer, so a
  // builder that writes exactly one screen passes all of them — while the
  // request the product actually receives is "put everything in one place".
  // That shape fails its own way: not a bad layout, a source that stops
  // halfway, because the binding ceiling is one completion's output and not the
  // page's 240k characters. The most expensive case in the suite (a bigger
  // budget, a bigger render) and the only one that measures reach.
  // generation (1)
  "page-giga-multi-view": { capability: "generation" },
  // ── The two write kinds nothing ever exercised (2026-08-21). `record` was
  // covered by the directory case; `bulk` and `link` were shipped, documented
  // and never measured, and each fails a way the page cannot show: a selection
  // run as N `record` calls half-succeeds against the bridge's rate limit, and
  // an assignment written as a field write is refused by name while the control
  // still renders. One case for both — a browser render is the expensive part.
  // tool-use (1)
  "page-bulk-and-link-writes": { capability: "tool-use" },
  // ── The chain, end to end (2026-08-21). Every other page case starts from a
  // type that already exists and rows that are already there, so none of them
  // measures `buildPage` where the product actually meets it: a file someone
  // dropped in the chat. Read, import, build — and the assertion follows the
  // PAGE back to the type it reads rather than guessing the key the agent
  // chose, so it grades the chain and not the assistant's vocabulary.
  // tool-use (1)
  "page-from-uploaded-file": { capability: "tool-use" },
};
