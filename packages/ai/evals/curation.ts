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
  // extraction (1)
  "rag-specific-id": { capability: "extraction", smoke: true },
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
};
