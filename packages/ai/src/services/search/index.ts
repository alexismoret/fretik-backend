import {
  HYBRID_CONSTANTS,
  type HybridCandidate,
  type HybridSearchFilters,
  hybridSearch,
} from "./hybrid-search";
import { generateQueryVariants } from "./multi-query";
import { getCachedOrEmbedBatch } from "./query-embedding-cache";
import { type RerankedCandidate, rerankCandidates } from "./reranker";

/**
 * Top-level RAG search orchestrator.
 *
 * Pipeline (see `chatbot-overhaul-plan.md` Phase 7c):
 *
 *   1. `generateQueryVariants(query)` — yields `[original, v1, v2]`
 *      via the cheap model. Returns `[original]` on LLM failure.
 *
 *   2. Embed all variants in a single OpenRouter `/embeddings` batch
 *      call (cheaper than 3 round-trips).
 *
 *   3. Run `hybridSearch` once per variant in parallel. Each call
 *      is itself a parallel (semantic, BM25) pair inside a Postgres
 *      transaction for the HNSW ef_search tuning. Each call returns
 *      up to `HYBRID_CONSTANTS.OUTPUT_SIZE` (50) fused candidates.
 *
 *   4. Global merge: each chunk's final pre-rerank score is the SUM
 *      of its per-variant RRF scores (chunks that surface in multiple
 *      variants get a boost). Then clip to the top 50.
 *
 *   5. Rerank the top 50 via Cohere Rerank 4 Fast on OpenRouter →
 *      final `topK` (default 20). Graceful fallback to RRF-only on
 *      failure.
 *
 * `filtersApplied` echoes the filters used verbatim so the chatbot UI
 * and debug panel can render what actually constrained the pool.
 *
 * `debugScores` is populated iff `ctx.ragDebug === true` so Phase 9.5's
 * debug panel can render per-chunk semantic/bm25/rrf/rerank scores.
 * In prod mode it's undefined — zero extra payload, zero extra CPU.
 */

export interface SearchRagInput {
  query: string;
  teamId: string;
  /**
   * Org-level scope. Required: covers user-scope context files
   * (which have `team_id IS NULL` but `organization_id` set) and
   * keeps the predicate symmetric with `team_id` so the planner can
   * combine partial indexes. Forwarded verbatim to `hybridSearch`.
   */
  organizationId: string;
  /**
   * User running the query. When set, user-scope rows owned by this
   * user (memories, context) become visible. When undefined (system
   * / internal flow), the predicate collapses to team-only — no
   * user-scope row leaks.
   */
  userId?: string;
  filters?: HybridSearchFilters;
  /** Final number of results after rerank. Default 20. */
  topK?: number;
  /** When true, populate `debugScores` on the response. Default false. */
  debug?: boolean;
  /**
   * When true, skip multi-query reformulation entirely — runs hybrid
   * search against the original query only. Use for callers where a
   * downstream stage (e.g. judge LLM) provides precision filtering and
   * the latency saving (~1–3 s on the cheap-model call + 2 extra
   * embeddings + 2 extra hybrid searches) is worth the recall trade.
   * Default false (full multi-query, preserves prior behaviour).
   */
  skipMultiQuery?: boolean;
}

export interface SearchRagDebugEntry {
  chunkId: string;
  semanticRank: number | null;
  bm25Rank: number | null;
  rrfScore: number;
  rerankScore: number | null;
  matchedVariants: number;
}

export interface SearchRagResult {
  results: RerankedCandidate[];
  /** Total number of distinct chunks evaluated at the rerank stage. */
  candidatesExamined: number;
  /** Query variants that were run (original + reformulations). */
  queryVariants: string[];
  /** Filters actually applied (verbatim echo, for UI). */
  filtersApplied: HybridSearchFilters | undefined;
  /** Per-chunk retrieval trace. Only present when `debug === true`. */
  debugScores?: SearchRagDebugEntry[];
}

const DEFAULT_TOP_K = 20;

/**
 * Fuses several `HybridCandidate[]` lists — one per query variant —
 * into a single ranked list. Each chunk's score is the sum of the
 * per-variant RRF scores already computed by `hybridSearch`, so a
 * chunk that hits high on two or three variants accumulates more
 * fused mass than a chunk that hit one variant alone. Identity is
 * by `chunk.id` (the UUID of the `ai_vectors` row).
 *
 * When a chunk appears in multiple lists we keep the instance with
 * the highest per-list `rrfScore` as the representative (same
 * content anyway, this is just to pick a consistent semanticRank /
 * bm25Rank for the debug panel).
 */
interface MergedCandidate extends HybridCandidate {
  /** How many query variants surfaced this chunk. */
  matchedVariants: number;
  /** Best per-variant rrfScore seen so far (for representative picking). */
  bestVariantScore: number;
}

const globalMerge = (
  perVariantResults: HybridCandidate[][],
): MergedCandidate[] => {
  const merged = new Map<string, MergedCandidate>();

  for (const list of perVariantResults) {
    for (const candidate of list) {
      const existing = merged.get(candidate.id);
      if (existing) {
        existing.rrfScore += candidate.rrfScore;
        existing.matchedVariants += 1;
        if (candidate.rrfScore > existing.bestVariantScore) {
          // Prefer the representative from the variant where this
          // chunk ranked strongest — the debug panel then shows the
          // highest-signal semantic/bm25 ranks rather than the first
          // variant's.
          existing.bestVariantScore = candidate.rrfScore;
          existing.semanticRank = candidate.semanticRank;
          existing.bm25Rank = candidate.bm25Rank;
        }
      } else {
        merged.set(candidate.id, {
          ...candidate,
          matchedVariants: 1,
          bestVariantScore: candidate.rrfScore,
        });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, HYBRID_CONSTANTS.OUTPUT_SIZE);
};

/**
 * End-to-end retrieval: reformulation → embed → parallel hybrid →
 * global merge → rerank. Never throws — upstream failures degrade
 * gracefully (empty `[variants]` from `generateQueryVariants`,
 * circuit-broken rerank, etc.).
 */
export const searchRAG = async (
  input: SearchRagInput,
): Promise<SearchRagResult> => {
  const {
    query,
    teamId,
    organizationId,
    userId,
    filters,
    topK = DEFAULT_TOP_K,
    debug = false,
    skipMultiQuery = false,
  } = input;

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      results: [],
      candidatesExamined: 0,
      queryVariants: [],
      filtersApplied: filters,
      ...(debug ? { debugScores: [] } : {}),
    };
  }

  // Stage 1 — reformulation (soft-fail returns [original]). When the
  // caller opts out, we skip the cheap-model round-trip and run hybrid
  // search against the original query alone.
  const queryVariants = skipMultiQuery
    ? [trimmed]
    : await generateQueryVariants(trimmed, teamId);
  if (queryVariants.length === 0) {
    return {
      results: [],
      candidatesExamined: 0,
      queryVariants: [],
      filtersApplied: filters,
      ...(debug ? { debugScores: [] } : {}),
    };
  }

  // Stage 2 — batch-embed all variants at once. Routed through the
  // Phase 8 Redis-backed query cache so a repeated query (follow-up,
  // typo retry, popular question across users) skips the OpenRouter
  // round-trip entirely and the multi-query expansion pays only for
  // the genuinely new reformulations.
  const variantEmbeddings = await getCachedOrEmbedBatch(queryVariants);

  // Stage 3 — parallel hybrid search per variant. Each call is
  // itself internally parallel (semantic + BM25).
  const perVariant = await Promise.all(
    queryVariants.map((variant, i) =>
      hybridSearch({
        query: variant,
        queryEmbedding: variantEmbeddings[i] ?? [],
        teamId,
        organizationId,
        userId,
        filters,
      }),
    ),
  );

  // Stage 4 — global weighted-RRF merge (scores are already weighted
  // at the hybrid-search level, so summation across variants is pure
  // additive boost for multi-variant hits).
  const merged = globalMerge(perVariant);
  if (merged.length === 0) {
    return {
      results: [],
      candidatesExamined: 0,
      queryVariants,
      filtersApplied: filters,
      ...(debug ? { debugScores: [] } : {}),
    };
  }

  // Stage 5 — rerank the top 50 with Cohere → top K.
  // Rerank key = the ORIGINAL query (not any reformulation) so the
  // final ordering reflects the user's actual intent.
  const reranked = await rerankCandidates(trimmed, merged, topK);

  const result: SearchRagResult = {
    results: reranked,
    candidatesExamined: merged.length,
    queryVariants,
    filtersApplied: filters,
  };

  if (debug) {
    const rerankedById = new Map(reranked.map((r) => [r.id, r.rerankScore]));
    result.debugScores = merged.map((c) => ({
      chunkId: c.id,
      semanticRank: c.semanticRank,
      bm25Rank: c.bm25Rank,
      rrfScore: c.rrfScore,
      rerankScore: rerankedById.get(c.id) ?? null,
      matchedVariants: c.matchedVariants,
    }));
  }

  return result;
};

export type { HybridSearchFilters, RerankedCandidate };
