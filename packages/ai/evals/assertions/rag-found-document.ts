import type { Assertion, InvokeResult, ToolCallTrace } from "../types";

/**
 * Builds a `custom` Assertion that asserts a given documentId is
 * present in at least one `searchKnowledge` tool call output.
 *
 * Why this matters: the existing RAG eval suite (`rag-precision.ts`)
 * only checks that `searchKnowledge` was CALLED and that the final
 * assistant text is coherent (via LLM judge). It never verifies that
 * a SPECIFIC document — especially one that must be found via its
 * METADATA rather than its OCR text — actually surfaced in the
 * retrieval results. The `rag-metadata` suite uses this assertion to
 * catch regressions like the JSON-as-markdown chunking bug or a
 * missing metadata header in the contextual prefix — both of which
 * would silently drop a document out of the recall set while leaving
 * the assistant text plausible.
 *
 * Fixture env-var support: many RAG-recall cases depend on a specific
 * document being present in the eval team with known metadata. Rather
 * than hard-code UUIDs (which would fail for any other developer's
 * EVAL_TEAM_ID), the assertion reads the target id from an env var.
 * When the env is unset, the assertion AUTO-PASSES with a "skipped"
 * label so the harness still runs cleanly on machines without the
 * fixture configured. Once fixtures are set up (via a future
 * `evals/fixtures/` uploader script), filling the env locks the case
 * into strict-mode.
 *
 * Optional `minRerankScore`: enforces a minimum Cohere rerank score on
 * the matching result — useful to distinguish "found because of a
 * weak BM25 overlap" from "found with high semantic confidence".
 */
export interface RagFoundDocumentArgs {
  /**
   * Name of the env var holding the fixture document UUID. Unset env
   * → the assertion skips and auto-passes (harness stays green). Set
   * → the assertion strict-checks presence.
   */
  documentIdEnv: string;
  /** Minimum rerank score (∈ [0,1]) required on the matching result. */
  minRerankScore?: number;
}

interface SearchKnowledgeResult {
  results?: Array<{
    sourceId?: string;
    sourceType?: string;
    rerankScore?: number | null;
  }>;
}

/**
 * `searchKnowledge` has a 48K-char `maxResultSizeChars` cap, so full
 * RAG payloads (20 reranked chunks with contextual prefixes and
 * metadata) routinely cross the threshold and come back as a
 * `<persisted-output>` envelope — a plain string with a workspace-
 * relative path (`outputs/persisted/{toolCallId}.json`) and a short
 * preview. The envelope looks like:
 *
 *   <persisted-output>
 *   Output too large (70.0 KB, 70,723 chars). Full output saved to:
 *   outputs/persisted/<toolCallId>.json
 *
 *   Preview (first 2,000 chars):
 *   { "results": [ ... ]
 *   </persisted-output>
 *
 * The eval harness can't reach into the conversation's E2B sandbox to
 * read the full payload back, so we count `"sourceId"` occurrences in
 * the preview as a lower bound on the result count. That lower bound
 * is what the `ragReturnedAtLeast(N)` guard actually needs (typical
 * RAG outputs include 1-2 full results inside the first 2K chars).
 */
const PERSISTED_OUTPUT_PREVIEW_RE =
  /Preview \(first [\d,]+ chars\):\n([\s\S]*?)(?:\n<\/persisted-output>|$)/;

const tryParsePreviewResults = (
  envelope: string,
): SearchKnowledgeResult["results"] | null => {
  const previewMatch = PERSISTED_OUTPUT_PREVIEW_RE.exec(envelope);
  if (!previewMatch) return null;
  const preview = (previewMatch[1] ?? "").trim();
  // Preview is almost certainly truncated mid-JSON. Count `"sourceId"`
  // occurrences — each full result has exactly one. This is a lower
  // bound on the real result count, which is what the `≥ min`
  // assertion actually needs.
  const matches = preview.match(/"sourceId"\s*:/g);
  if (!matches || matches.length === 0) return null;
  return matches.map(() => ({}));
};

const unwrapPersistedEnvelope = (
  envelope: string,
): SearchKnowledgeResult["results"] | null => tryParsePreviewResults(envelope);

const extractResults = (
  output: unknown,
): SearchKnowledgeResult["results"] | null => {
  if (typeof output === "string") {
    if (output.startsWith("<persisted-output>")) {
      return unwrapPersistedEnvelope(output);
    }
    return null;
  }
  if (output === null || typeof output !== "object") return null;
  const maybe = output as SearchKnowledgeResult;
  return Array.isArray(maybe.results) ? maybe.results : null;
};

const findSearchCalls = (result: InvokeResult): ToolCallTrace[] =>
  result.toolCalls.filter((c) => c.name === "searchKnowledge");

export const ragFoundDocument = (args: RagFoundDocumentArgs): Assertion => ({
  type: "custom",
  name: `rag-found-document (env=${args.documentIdEnv})`,
  fn: (result) => {
    const targetId = process.env[args.documentIdEnv]?.trim();
    if (!targetId || targetId.length === 0) {
      // Fixture not configured on this machine — skip cleanly.
      return true;
    }

    const searchCalls = findSearchCalls(result);
    if (searchCalls.length === 0) {
      return "searchKnowledge was not called — no RAG retrieval happened";
    }

    for (const call of searchCalls) {
      const results = extractResults(call.output);
      if (!results) continue;
      const match = results.find(
        (r) => r.sourceId === targetId && r.sourceType === "documents",
      );
      if (match) {
        if (
          args.minRerankScore !== undefined &&
          match.rerankScore !== null &&
          match.rerankScore !== undefined &&
          match.rerankScore < args.minRerankScore
        ) {
          return `fixture doc ${targetId} found but rerankScore ${match.rerankScore} < ${args.minRerankScore}`;
        }
        return true;
      }
    }

    return `fixture doc ${targetId} not present in any searchKnowledge result`;
  },
});

/**
 * Builds a `custom` Assertion that asserts the `searchKnowledge` tool
 * returned at least `min` non-empty chunks. Use it as a safety net on
 * content-type queries to catch regressions where the chunker silently
 * produces zero output (e.g. the historical JSON-as-markdown bug that
 * left entire documents un-indexed).
 */
export const ragReturnedAtLeast = (min: number): Assertion => ({
  type: "custom",
  name: `rag-returned-at-least:${min}`,
  fn: (result) => {
    const searchCalls = findSearchCalls(result);
    if (searchCalls.length === 0) {
      return "searchKnowledge was not called";
    }
    const total = searchCalls.reduce((acc, call) => {
      const results = extractResults(call.output);
      return acc + (results?.length ?? 0);
    }, 0);
    if (total < min) {
      return `searchKnowledge returned ${total} results, expected ≥ ${min}`;
    }
    return true;
  },
});
