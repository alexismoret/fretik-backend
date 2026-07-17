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
  // extraction (2)
  "rag-specific-id": { capability: "extraction", smoke: true },
  "file-pdf-read": { capability: "extraction", smoke: true },
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
  // routing, plain language, proactive etiquette. See cases/doctrine.ts.
  "doc-python-one-call": { capability: "tool-use" },
  "doc-skill-first-xlsx": { capability: "tool-use" },
  "doc-rag-first-content": { capability: "tool-use" },
  "doc-plain-language": { capability: "instruction-following", smoke: true },
  "doc-proactive-workflow": { capability: "reasoning" },
  "doc-proactive-memory": { capability: "reasoning" },
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
  // objects (9)
  "obj-explicit-create": { capability: "objects" },
  "obj-implicit-create": { capability: "objects" },
  "obj-relevance-gate": { capability: "objects" },
  "obj-propose-schema": { capability: "objects" },
  "obj-partial-update-no-data-loss": { capability: "objects" },
  "obj-rich-create": { capability: "objects" },
  "obj-bulk-csv-import": { capability: "objects" },
  "obj-sql-to-csv": { capability: "objects" },
  "obj-location-create": { capability: "objects" },
};
