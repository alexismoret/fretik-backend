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
}

export const CURATED: Record<string, CuratedCase> = {
  // extraction (2)
  "rag-specific-id": { capability: "extraction", smoke: true },
  "file-pdf-read": { capability: "extraction", smoke: true },
  // generation (3)
  "edge-unicode-identifier": { capability: "generation", smoke: true },
  "qa-clarify": { capability: "generation", smoke: true },
  "qa-generalist-offtopic": { capability: "generation" },
  // external-actions (10)
  "bash-description-field": { capability: "external-actions" },
  "bash-list-workspace": { capability: "external-actions", smoke: true },
  "bash-no-network": { capability: "external-actions" },
  "dispatch-explicit-instruction": { capability: "external-actions" },
  "dispatch-no-recursion": { capability: "external-actions" },
  "file-cross-conv-isolation": { capability: "external-actions" },
  "lat-sql-simple": { capability: "external-actions", smoke: true },
  "mem-refuse-team-opinion": { capability: "external-actions" },
  "rag-metadata-entity-only": { capability: "external-actions", smoke: true },
  "rag-metadata-excel-summary": { capability: "external-actions" },
  // reasoning (6)
  "dispatch-multi-source-synthesis": { capability: "reasoning" },
  "dispatch-trivial-skip": { capability: "reasoning" },
  "edge-empty-corpus": { capability: "reasoning" },
  "multi-no-overkill": { capability: "reasoning", smoke: true },
  "qa-greet": { capability: "reasoning" },
  "rag-no-match": { capability: "reasoning", smoke: true },
  // ── C3 model-gate suites (2026-06-11) — written against OUR tools,
  // method borrowed from public benchmarks (BFCL / IFEval / LongBench),
  // never imported data. See evals/cases/{tool-portability,
  // instruction-following,long-context}.ts.
  // tool-use (15 — incl. 3 informational `parallel` probes)
  "tp-sql-quoting": { capability: "tool-use", smoke: true },
  "tp-sql-aggregate": { capability: "tool-use" },
  "tp-python-multiline": { capability: "tool-use", smoke: true },
  "tp-read-offset": { capability: "tool-use" },
  "tp-xlsx-python": { capability: "tool-use" },
  "tp-memory-view": { capability: "tool-use" },
  "tp-searchtools-activation": { capability: "tool-use" },
  "tp-manage-tasks": { capability: "tool-use" },
  "tp-present-files": { capability: "tool-use" },
  "tp-dispatch-cheap": { capability: "tool-use" },
  "tp-websearch-date": { capability: "tool-use" },
  "tp-vision-image": { capability: "tool-use" },
  "par-two-sql": { capability: "tool-use" },
  "par-sql-web": { capability: "tool-use" },
  "par-two-reads": { capability: "tool-use" },
  // instruction-following (8 — incl. 2 `structured-output` probes)
  "if-bullet-count": { capability: "instruction-following", smoke: true },
  "if-forbidden-word": { capability: "instruction-following" },
  "if-uppercase": { capability: "instruction-following" },
  "if-word-limit": { capability: "instruction-following" },
  "if-prefix-suffix": { capability: "instruction-following" },
  "if-no-tools": { capability: "instruction-following" },
  "if-json-only": { capability: "instruction-following", smoke: true },
  "if-json-fenced": { capability: "instruction-following" },
  // long-context (2 — NEVER smoke: long runs, see session-8 note above)
  "lc-deep-retrieval": { capability: "long-context" },
  "lc-multidoc-qa": { capability: "long-context" },
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
  // isolates the multimodal delta. See evals/cases/multimodal.ts.
  // multimodal (4)
  "mm-image-scene-qa": { capability: "multimodal", smoke: true },
  "mm-chart-reading": { capability: "multimodal" },
  "mm-image-plus-text": { capability: "multimodal" },
  "mm-video-qa": { capability: "multimodal" },
};
