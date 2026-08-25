import db from "@fretik/shared/db";
import type { AiVectorSourceType } from "@fretik/shared/db/schema";
import { aiVectors } from "@fretik/shared/db/schema";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { EMBEDDING_DIMENSIONS } from "../../lib/embeddings";
import { fuseArms, type HybridCandidate, type RawRow } from "./fuse-arms";
import {
  type RegistryRow,
  runRecordRegistrySearch,
} from "./record-registry-search";

export type { HybridCandidate } from "./fuse-arms";

/**
 * Parallel hybrid search: HNSW semantic + BM25 lexical over `ai_vectors`,
 * plus a lexical arm over the RECORD REGISTRY, fused via weighted RRF
 * per the Anthropic Contextual Retrieval cookbook (semantic 0.8 /
 * BM25 0.2 — NOT the standard uniform k=60 RRF).
 *
 * The three searches run in parallel — the semantic side wraps its
 * `SELECT` in a transaction so `SET LOCAL hnsw.ef_search` applies
 * only to that query. Results are merged in application code with
 * weighted-RRF scoring; the top 50 fused candidates are returned.
 *
 *   semantic:   ORDER BY embedding <=> :qvec::halfvec   → top 150
 *   bm25    :   ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', :q)) DESC
 *                                                       → top 150
 *   registry:   same probe against `collection_records.search_vector` → top 150
 *   fusion  :   score = Ws/(rank+1)_sem + Wb/(rank+1)_bm25 + Wr/(rank+1)_reg
 *   output  :   top 50 by fused score
 *
 * The registry arm reads a DIFFERENT table, and that is the point: the
 * other two are blind to anything never embedded, which by policy is
 * every record of a type past `CARD_INDEX_ROW_CEILING`. See
 * `record-registry-search.ts` for why it costs nothing.
 *
 * Both sides MUST apply the 3-arm scope predicate — mandatory
 * isolation per `keyDecisions.sql_rules` and the
 * `ai_vectors_scope_consistency` CHECK introduced in S3+S4:
 *
 *     (team_id = $teamId OR team_id IS NULL)
 * AND (user_id IS NULL OR user_id = $userId)
 * AND (organization_id = $orgId OR organization_id IS NULL)
 *
 * This single predicate covers every legal row shape — tenant
 * documents, team-scope memories/context, user-scope memories
 * (team_id set, user_id = $userId), global skills (all three
 * NULL), and user-scope context files (team_id NULL,
 * organization_id set, user_id = $userId). When `userId` is
 * undefined (system / internal flow with no acting user), the
 * second clause collapses to `user_id IS NULL` so no user-scope
 * row leaks. Phase 7a.1 partial indexes (`idx_ai_vectors_global`,
 * `idx_ai_vectors_team_user_partial`) make the OR-shaped predicate
 * planner-friendly on Postgres 17 + pgvector 0.8.
 *
 * BM25 tokeniser is locked to `'simple'` to match the GENERATED STORED
 * `search_vector` column's `to_tsvector('simple', ...)` expression
 * (see `keyDecisions.phase7Bm25Tokenizer`). Any other regconfig would
 * build a different lexeme set and the GIN index would be skipped.
 *
 * Filter surface is intentionally minimal: `sourceTypes` and
 * `sourceIds`. Every other metadata filter (document_type,
 * document_date, uploaded_at, category…) is already reachable via
 * the dedicated domain tool (`listDocuments`) or `querySql`. The
 * expected two-step pattern is:
 * model calls the right list tool with its own rich filters →
 * collects the matching ids → calls rag-search with `sourceIds:
 * [...]`. This keeps the RAG tool surface small and avoids
 * duplicating filter semantics across tools.
 */

/** Final candidate pool returned by the hybrid stage. */
const HYBRID_OUTPUT_SIZE = 50;

/** Per-search candidate pool before fusion. */
const PER_SEARCH_LIMIT = 150;

/** Weighted-RRF coefficients per the Anthropic cookbook. */
const SEMANTIC_WEIGHT = 0.8;
const BM25_WEIGHT = 0.2;

/**
 * Weight of the record-registry arm — the same as BM25, because it IS a BM25
 * arm, only over `collection_records.search_vector` instead of `ai_vectors`.
 *
 * It does not need to be higher, and raising it would be a mistake. RRF here is
 * a RECALL stage: its only job is to get a candidate into the 50 that reach the
 * reranker, which then scores actual relevance to the query. At 0.2 a rank-1
 * registry hit scores 0.1, which outranks a semantic hit at rank 7 — comfortably
 * inside the pool. A record card that ALSO matches lexically accumulates both
 * lexical arms, which is corroboration, not double counting: it matched two
 * separately maintained representations of the same row.
 */
const REGISTRY_WEIGHT = 0.2;

/**
 * HNSW query-time parameter. The pgvector default is 40, too low for
 * high-recall RAG — 100 is the Anthropic / Crunchy Data recommended
 * value for 768-2560 dim embeddings with `m=16, ef_construction=200`.
 */
const HNSW_EF_SEARCH = 100;

export interface HybridSearchFilters {
  /**
   * Narrow the candidate pool to specific `ai_vectors.source_type`
   * values. Indexed on `idx_ai_vectors_source` (composite with
   * `source_id`) so filtering is free. Useful when a query is
   * unambiguously about one kind of source ("search inside
   * documents …") and you don't want the other kinds' chunks
   * diluting the rerank pool.
   */
  sourceTypes?: AiVectorSourceType[];
  /**
   * Narrow the candidate pool to specific source rows — the
   * documents the model has already pre-selected via
   * `listDocuments`. This is the universal bridge
   * between the structured domain tools and the semantic RAG tool:
   * pre-filter structurally via the domain tools, then
   * semantic-search ONLY inside the returned ids. Indexed on
   * `idx_ai_vectors_source`.
   */
  sourceIds?: string[];
}

export interface HybridSearchInput {
  query: string;
  queryEmbedding: number[];
  teamId: string;
  /**
   * Org-level scope. Required: covers user-scope context files
   * (which have `team_id IS NULL` but `organization_id` set per the
   * S4 3-arm CHECK) and provides the symmetric AND-clause that lets
   * the planner combine the global / team-user partial indexes.
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
}

const serializeHalfvec = (embedding: number[]): string =>
  `[${embedding.join(",")}]`;

const buildFilterClauses = (
  teamId: string,
  organizationId: string,
  userId: string | undefined,
  filters: HybridSearchFilters | undefined,
): SQL[] => {
  // Scope predicate — 3 symmetric AND-clauses validating every legal
  // row shape per the `ai_vectors_scope_consistency` CHECK constraint
  // (S3+S4). The CHECK guarantees that team_id and organization_id
  // either co-NULL (skills) or co-set (everything else); we still
  // state both clauses explicitly so the planner can pick the partial
  // index that fits the result population (idx_ai_vectors_global for
  // skills, idx_ai_vectors_team_user_partial for memories/context).
  //
  // When `userId` is undefined (system / internal flow with no acting
  // user), the user-scope clause collapses to `user_id IS NULL` —
  // user-owned rows stay invisible, no leak.
  const userScopeClause = userId
    ? (or(isNull(aiVectors.userId), eq(aiVectors.userId, userId)) as SQL)
    : isNull(aiVectors.userId);

  const clauses: SQL[] = [
    or(eq(aiVectors.teamId, teamId), isNull(aiVectors.teamId)) as SQL,
    userScopeClause,
    or(
      eq(aiVectors.organizationId, organizationId),
      isNull(aiVectors.organizationId),
    ) as SQL,
  ];
  if (!filters) return clauses;

  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    clauses.push(inArray(aiVectors.sourceType, filters.sourceTypes));
  }
  if (filters.sourceIds && filters.sourceIds.length > 0) {
    clauses.push(inArray(aiVectors.sourceId, filters.sourceIds));
  }
  return clauses;
};

/**
 * Whether the registry arm can contribute at all. It only ever produces
 * `records`, so a caller that filtered them out must not pay for the query —
 * and an unfiltered caller must still get it, since "all source types" includes
 * records.
 */
const wantsRecords = (filters: HybridSearchFilters | undefined): boolean =>
  !filters?.sourceTypes ||
  filters.sourceTypes.length === 0 ||
  filters.sourceTypes.includes("records");

const runSemanticSearch = async (
  queryEmbedding: number[],
  teamId: string,
  organizationId: string,
  userId: string | undefined,
  filters: HybridSearchFilters | undefined,
): Promise<RawRow[]> => {
  const vectorLiteral = serializeHalfvec(queryEmbedding);
  const clauses = buildFilterClauses(teamId, organizationId, userId, filters);
  const distance = sql<number>`${aiVectors.embedding} <=> ${vectorLiteral}::halfvec`;

  return db.transaction(async (tx) => {
    // SET LOCAL only scopes to the current transaction — the wrapping
    // `db.transaction` is mandatory for the tuning to take effect.
    await tx.execute(
      sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(HNSW_EF_SEARCH))}`,
    );
    return tx
      .select({
        id: aiVectors.id,
        content: aiVectors.content,
        contextualPrefix: aiVectors.contextualPrefix,
        metadata: aiVectors.metadata,
        sourceType: aiVectors.sourceType,
        sourceId: aiVectors.sourceId,
        chunkIndex: aiVectors.chunkIndex,
        totalChunks: aiVectors.totalChunks,
        createdAt: aiVectors.createdAt,
      })
      .from(aiVectors)
      .where(and(...clauses))
      .orderBy(distance)
      .limit(PER_SEARCH_LIMIT);
  });
};

const runBm25Search = async (
  queryText: string,
  teamId: string,
  organizationId: string,
  userId: string | undefined,
  filters: HybridSearchFilters | undefined,
): Promise<RawRow[]> => {
  const clauses = buildFilterClauses(teamId, organizationId, userId, filters);
  // The GIN-indexed `search_vector` column is a GENERATED STORED
  // tsvector whose tokeniser is `'simple'` (see ai-vectors.ts) —
  // plainto_tsquery must match or the index is skipped.
  const tsquery = sql`plainto_tsquery('simple', ${queryText})`;
  const matchClause = sql`${aiVectors.searchVector} @@ ${tsquery}`;
  const rankExpr = sql<number>`ts_rank_cd(${aiVectors.searchVector}, ${tsquery})`;

  return db
    .select({
      id: aiVectors.id,
      content: aiVectors.content,
      contextualPrefix: aiVectors.contextualPrefix,
      metadata: aiVectors.metadata,
      sourceType: aiVectors.sourceType,
      sourceId: aiVectors.sourceId,
      chunkIndex: aiVectors.chunkIndex,
      totalChunks: aiVectors.totalChunks,
      createdAt: aiVectors.createdAt,
    })
    .from(aiVectors)
    .where(and(...clauses, matchClause))
    .orderBy(sql`${rankExpr} DESC`)
    .limit(PER_SEARCH_LIMIT);
};

/**
 * Runs the semantic and BM25 searches in parallel, fuses them via
 * weighted RRF, and returns the top `HYBRID_OUTPUT_SIZE` candidates.
 *
 * Never throws on empty sides: if either search returns zero rows the
 * fusion degrades gracefully to the non-empty side. If both return
 * zero, the output is `[]`.
 *
 * Callers running multi-query reformulation invoke this once per
 * variant with the matching `queryEmbedding`.
 */
export const hybridSearch = async (
  input: HybridSearchInput,
): Promise<HybridCandidate[]> => {
  const { query, queryEmbedding, teamId, organizationId, userId, filters } =
    input;

  // Guard against a missing / malformed embedding (upstream provider
  // timeout, quota, dimension mismatch). Serialising `[]::halfvec`
  // produces an invalid SQL literal that fails the whole transaction,
  // so we skip the semantic side entirely and let BM25 carry the query.
  // Logged as a warning because it indicates an upstream incident, not
  // a normal empty-corpus scenario.
  const hasValidEmbedding =
    Array.isArray(queryEmbedding) &&
    queryEmbedding.length === EMBEDDING_DIMENSIONS;
  if (!hasValidEmbedding) {
    console.warn(
      `[hybrid-search] invalid query embedding (len=${queryEmbedding?.length ?? 0}, expected=${EMBEDDING_DIMENSIONS}) — falling back to BM25-only`,
    );
  }

  const [semanticRows, bm25Rows, registryRows] = await Promise.all([
    hasValidEmbedding
      ? runSemanticSearch(
          queryEmbedding,
          teamId,
          organizationId,
          userId,
          filters,
        )
      : Promise.resolve<RawRow[]>([]),
    runBm25Search(query, teamId, organizationId, userId, filters),
    wantsRecords(filters)
      ? runRecordRegistrySearch({
          queryText: query,
          teamId,
          organizationId,
          recordIds: filters?.sourceIds,
          // Deliberately shallower than the two vector arms. They fetch 150
          // because a candidate buried in one can be shallow in the other, and
          // cross-arm accumulation lifts it into the output. Nothing can lift a
          // registry-only candidate — this arm is its only source — so a hit at
          // registry rank r is outscored by the r-1 hits above it, and rank 51
          // can never reach a top-50 output. Fetching deeper is provably wasted.
          limit: HYBRID_OUTPUT_SIZE,
        })
      : Promise.resolve<RegistryRow[]>([]),
  ]);

  return fuseArms({
    semanticRows,
    bm25Rows,
    registryRows,
    weights: {
      semantic: SEMANTIC_WEIGHT,
      bm25: BM25_WEIGHT,
      registry: REGISTRY_WEIGHT,
    },
    outputSize: HYBRID_OUTPUT_SIZE,
  });
};

export const HYBRID_CONSTANTS = {
  OUTPUT_SIZE: HYBRID_OUTPUT_SIZE,
  PER_SEARCH_LIMIT,
  SEMANTIC_WEIGHT,
  BM25_WEIGHT,
  REGISTRY_WEIGHT,
  HNSW_EF_SEARCH,
} as const;
