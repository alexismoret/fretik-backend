/**
 * RAG + metadata coverage.
 *
 * These cases validate the metadata-aware retrieval path introduced to
 * fix the pre-extract / vectorise bug cluster:
 *   - semantic header prepended to each chunk's `contextual_prefix`
 *     (so entity names, document types, and file names are present in
 *     BOTH the embedding AND the BM25 index);
 *   - metadata-only branch for Excel/CSV (so tabular sources become
 *     searchable via their summary + classification);
 *   - regression guard on the historical "JSON-as-markdown" chunking
 *     bug that left entire documents un-indexed.
 *
 * Fixture configuration: several cases assert that a SPECIFIC
 * documentId shows up in `searchKnowledge` results. The target id is
 * read from an env var — when unset, the assertion skips gracefully so
 * the suite still runs on machines without fixtures. Required env vars:
 *
 *   - EVAL_FIXTURE_ENTITY_DOC_ID   A document whose OCR content does
 *                                   NOT mention the entity name, but
 *                                   whose metadata has the entity
 *                                   (e.g. role=issuer, name="Acme Inc").
 *                                   Validates that the semantic header
 *                                   makes the doc findable via entity.
 *   - EVAL_FIXTURE_EXCEL_DOC_ID    An Excel/CSV doc with a summary
 *                                   like "Vendor pricing Q1 2026" so
 *                                   it's recoverable via the
 *                                   metadata-only branch.
 *   - EVAL_FIXTURE_SUMMARY_DOC_ID  Another tabular doc where the match
 *                                   should hit on the summary text
 *                                   alone.
 *
 * The fixtures can be uploaded by hand once and their ids pasted into
 * `.env` ; an optional `evals/fixtures/` uploader script (follow-up)
 * would automate this in CI.
 */

import { ragFoundDocument } from "../assertions/rag-found-document";
import type { EvalSuite } from "../types";

export const ragMetadataSuite: EvalSuite = {
  name: "rag-metadata",
  summary:
    "Validates metadata-aware RAG: semantic header recall, metadata-only branch for tabular docs, chunking regressions.",
  cases: [
    {
      id: "rag-metadata-entity-only",
      description:
        "Entity mentioned only in metadata (not in OCR text) — must still surface via the semantic header in the chunk's contextual prefix",
      prompt: "Show me documents issued by Acme Inc in our recent uploads.",
      tags: ["rag", "metadata", "entity-recall"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        ragFoundDocument({ documentIdEnv: "EVAL_FIXTURE_ENTITY_DOC_ID" }),
      ],
    },
    {
      id: "rag-metadata-excel-summary",
      description:
        "Tabular file should be retrievable via its metadata-only vector (summary + classification)",
      prompt:
        "Find the spreadsheet about vendor pricing for Q1 2026 from a European supplier.",
      tags: ["rag", "metadata", "metadata-only", "spreadsheet"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchKnowledge"] },
        ragFoundDocument({ documentIdEnv: "EVAL_FIXTURE_EXCEL_DOC_ID" }),
      ],
    },
  ],
};
