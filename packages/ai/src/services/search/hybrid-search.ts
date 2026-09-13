import db from "@fretik/shared/db";
import type { AiVectorSourceType } from "@fretik/shared/db/schema";
import { aiVectors } from "@fretik/shared/db/schema";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { EMBEDDING_DIMENSIONS } from "../../lib/embeddings";
import {
  formatTimings,
  type StageTimings,
  timeStage,
} from "../../lib/turn-timings";
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
 * HNSW query-time candidate list size — how many neighbours the graph search
 * keeps in flight, and therefore WHICH rows come back.
 *
 * 400, and it is a measurement (2026-09-10, ten real eval questions against the
 * EVAL team's 20 108-row knowledge partition; every result compared against the
 * exact scan's answer, and every plan asserted to be the HNSW index scan —
 * three earlier attempts at this table were artefacts of a planner that had
 * quietly answered exactly):
 *
 *   ef    rows/150   recall@20   recall@150   RRF mass   ms
 *   40    150        97.5 %      84.5 %       92.7 %     59
 *   100   150        98.0 %      87.7 %       94.7 %     46
 *   200   150        100 %       95.1 %       98.3 %     52
 *   400   150        100 %       98.1 %       99.4 %     62
 *   800   150        100 %       99.7 %       99.9 %     70
 *
 * against 225 ms for the exact answer. "RRF mass" is the share of this arm's
 * fusion weight `SEMANTIC_WEIGHT/(rank+1)` that survives, which is the honest
 * metric: a row missed at rank 150 is worth a fiftieth of one missed at rank 1.
 *
 * The top of the ranking is EXACT from ef=200 up, and the top is all that
 * survives fusion and rerank — so this constant does not trade precision for
 * speed, it trades the depth of a tail nothing reads. 400 is where another
 * 10 ms stops buying a measurable tail.
 *
 * It is not self-correcting: a fixed ef returns a worse tail as the corpus
 * grows. `HNSW_ITERATIVE_SCAN` and the famine probe below are what hold as
 * volume changes; re-run the table if the corpus changes by an order of
 * magnitude.
 */
const HNSW_EF_SEARCH = 400;

/**
 * What pgvector does when the scope filter leaves fewer than `LIMIT` rows in
 * the candidate list: `off` returns SHORT, `strict_order` re-scans with a
 * growing list until it has them, still in exact distance order.
 *
 * This — not `ef_search` — is the load-bearing setting. In the same
 * measurement, `off` at the pgvector default ef=40 returned **32 of the 150
 * rows asked for**, and at this file's previous ef=100 it returned **87 of
 * 150**: no error, no log, just a third of the arm missing. Under
 * `strict_order` every ef returned 150/150. So `ef_search` decides which rows
 * come back and this decides how many, and only this one keeps its guarantee
 * as the corpus grows.
 */
const HNSW_ITERATIVE_SCAN = "strict_order";

/**
 * Kill switch for the index, without a deploy.
 *
 * `hnsw` (default) tunes the index and leaves the choice to the planner.
 * `exact` forbids the index scan, so the planner falls back to a full scan plus
 * a sort — the plan this arm ran until `HNSW_EF_SEARCH` reached 400, and the
 * rollback if the index ever misbehaves in production.
 *
 * Called `exact` rather than `seqscan` because that is what it actually
 * guarantees: the planner may answer with a bitmap heap scan instead of a
 * sequential one (measured — it does), and both are exact.
 *
 * Worth knowing before reaching for it: falling back here is a LATENCY
 * decision, not a correctness one. The exact plan costs 225 ms against the
 * index's ~50 ms on 20 108 rows and grows linearly, but it cannot return a
 * wrong row. The dangerous direction is the other one — an index scan without
 * `HNSW_ITERATIVE_SCAN` — and that pairing is not reachable from here.
 */
const SEMANTIC_SCAN_MODE: "hnsw" | "exact" =
  process.env.SEMANTIC_SCAN_MODE === "exact" ? "exact" : "hnsw";

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
  /**
   * The query vector, or a promise for it. A promise lets the two lexical arms
   * run through the embedding round trip instead of behind it — see the note in
   * `hybridSearch`.
   */
  queryEmbedding: number[] | Promise<number[]>;
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

/**
 * Which slice of the corpus a call is searching, for the log line.
 *
 * `searchRAG` fires three of these per turn against wildly different
 * populations — tens of thousands of rows for the knowledge arm, a hundred for
 * documents, a handful for workflows and pages. Without this the `[hybrid]`
 * timings pool all three into one distribution and a regression in the only arm
 * that scans anything is invisible.
 */
export const armLabel = (filters: HybridSearchFilters | undefined): string =>
  filters?.sourceTypes && filters.sourceTypes.length > 0
    ? filters.sourceTypes.join("+")
    : "all";

/**
 * The per-transaction tuning, as ONE statement.
 *
 * `set_config(…, is_local => true)` is `SET LOCAL` in function form, which is
 * the whole reason to use it: two settings fit in one statement, where two
 * `SET LOCAL`s would cost two round trips to a database that is not local.
 *
 * The transaction it needs is not free — four round trips for a query worth one
 * — and moving these onto the CONNECTION instead (libpq startup options) does
 * work and does remove it. It was tried and reverted: isolated, a single search
 * went 279 ms → 87 ms, but under the real workload of three concurrent arms the
 * semantic arm went 233 ms → 381 ms and the gather 705 ms → 1 020 ms. The
 * isolated probe measured one query at a time and did not describe this system.
 * See `evals/RUNBOOK.md` before trying it again.
 */
const semanticTuning = (mode: "hnsw" | "exact" = SEMANTIC_SCAN_MODE): SQL =>
  mode === "exact"
    ? sql`SELECT set_config('enable_indexscan', 'off', true)`
    : sql`SELECT set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true), set_config('hnsw.iterative_scan', ${HNSW_ITERATIVE_SCAN}, true)`;

/**
 * Whether a short arm is worth investigating at all.
 *
 * Exported because it is the only decision here worth a test: it is what stands
 * between a warning that means something and one that fires on every small
 * tenant until everyone filters it out.
 */
export const shouldProbeForFamine = (
  rowsReturned: number,
  mode: "hnsw" | "exact" = SEMANTIC_SCAN_MODE,
): boolean => mode === "hnsw" && rowsReturned < PER_SEARCH_LIMIT;

/**
 * A short semantic arm is either a small corpus or a famished index, and the
 * two could not matter more differently: the second is silent, gets worse with
 * volume, and is the single failure mode this phase exists to prevent. So the
 * arm's row count alone is not the signal — "there is a 151st matching row and
 * we did not get it" is. That costs one cheap existence probe.
 *
 * **It runs on most searches, not on rare ones.** Two of the three arms recall
 * fires are honestly smaller than `PER_SEARCH_LIMIT` (118 documents, 6 workflows
 * and pages on the EVAL team), so they come back "short" every time and get
 * probed every time — about two extra statements per turn. That is deliberate
 * and it is why the probe is a bounded existence check over an indexed
 * predicate rather than a count: on a small partition it stops after scanning
 * what is there. It is also why it is NOT awaited — the arm it describes has
 * already answered, and awaiting it would put a round trip on the critical path
 * of every search of every team whose corpus is under 150 rows.
 *
 * The 23/23 gate at ten repeats was measured with these probes running, so
 * their cost is inside that number and not on top of it.
 */
const warnIfFamished = async (
  clauses: SQL[],
  rowsReturned: number,
  arm: string,
): Promise<void> => {
  const more = await db
    .select({ present: sql<number>`1` })
    .from(aiVectors)
    .where(and(...clauses))
    .offset(PER_SEARCH_LIMIT)
    .limit(1);
  if (more.length === 0) return;
  console.warn(
    `[hybrid-search] arm=${arm} semantic returned ${String(rowsReturned)}/${String(PER_SEARCH_LIMIT)} rows while more match — HNSW famine. Check hnsw.iterative_scan (set to ${HNSW_ITERATIVE_SCAN}), hnsw.ef_search (${String(HNSW_EF_SEARCH)}) and hnsw.max_scan_tuples, which caps an iterative scan at 20 000 tuples by default.`,
  );
};

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

  const rows = await db.transaction(async (tx) => {
    // `SET LOCAL` scopes to the current transaction only — the wrapping
    // `db.transaction` is mandatory for the tuning to take effect at all.
    await tx.execute(semanticTuning());
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

  if (shouldProbeForFamine(rows.length)) {
    void warnIfFamished(clauses, rows.length, armLabel(filters)).catch(
      (err: unknown) => {
        console.warn(
          "[hybrid-search] famine probe failed:",
          err instanceof Error ? err.message : err,
        );
      },
    );
  }
  return rows;
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

  // The two LEXICAL arms start now, without waiting for the embedding.
  //
  // Only the semantic arm needs a vector, and `queryEmbedding` may still be in
  // flight — a round trip to an 8B embedding model, the single slowest hop in
  // retrieval. Taking it as a promise and awaiting it inside the semantic
  // branch means BM25 and the record registry run THROUGH that wait instead of
  // after it, so a search costs `max(embed, lexical) + fuse` rather than
  // `embed + max(semantic, lexical)`. Callers that already hold the vector pass
  // it directly; `Promise.resolve` makes both shapes one code path.
  //
  // Guard against a missing / malformed embedding (upstream provider timeout,
  // quota, dimension mismatch). Serialising `[]::halfvec` produces an invalid
  // SQL literal that fails the whole transaction, so we skip the semantic side
  // entirely and let BM25 carry the query. Logged as a warning because it
  // indicates an upstream incident, not a normal empty-corpus scenario.
  const semanticPromise = Promise.resolve(queryEmbedding)
    .then((vector) => {
      if (Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS) {
        return runSemanticSearch(
          vector,
          teamId,
          organizationId,
          userId,
          filters,
        );
      }
      console.warn(
        `[hybrid-search] invalid query embedding (len=${vector?.length ?? 0}, expected=${EMBEDDING_DIMENSIONS}) — falling back to BM25-only`,
      );
      return [];
    })
    // An embedding provider that fails now costs the SEMANTIC arm, not the
    // search. Before the lexical arms ran in parallel there was nothing to
    // fall back to — the rejection surfaced from `searchRAG` and recall's own
    // `.catch` turned it into an empty memory block — so a bad minute at the
    // embeddings endpoint took memory offline entirely. The two lexical arms
    // have already answered by the time this settles; serve them.
    .catch((err: unknown) => {
      console.warn(
        "[hybrid-search] embedding unavailable — serving lexical arms only:",
        err instanceof Error ? err.message : err,
      );
      return [];
    });

  // Per-arm attribution. The three run on separate connections, so this stage
  // costs `max(arm)` — and which arm that is decides whether a slow search is
  // an HNSW tuning question, a full-text index question, or neither. Without
  // it the `[search] hybrid=` figure names a stage but not a suspect.
  const armTimings: StageTimings = {};
  const [semanticRows, bm25Rows, registryRows] = await Promise.all([
    timeStage(armTimings, "semantic", semanticPromise),
    timeStage(
      armTimings,
      "bm25",
      runBm25Search(query, teamId, organizationId, userId, filters),
    ),
    wantsRecords(filters)
      ? timeStage(
          armTimings,
          "registry",
          runRecordRegistrySearch({
            queryText: query,
            teamId,
            organizationId,
            recordIds: filters?.sourceIds,
            // Deliberately shallower than the two vector arms. They fetch 150
            // because a candidate buried in one can be shallow in the other, and
            // cross-arm accumulation lifts it into the output. Nothing can lift a
            // registry-only candidate — this arm is its only source — so a hit at
            // registry rank r is outscored by the r-1 hits above it, and rank 51
            // can never reach a top-50 output. Fetching deeper is provably
            // wasted.
            limit: HYBRID_OUTPUT_SIZE,
          }),
        )
      : Promise.resolve<RegistryRow[]>([]),
  ]);
  console.info(
    `[hybrid] arm=${armLabel(filters)} scan=${SEMANTIC_SCAN_MODE} ${formatTimings(armTimings)} rows=${String(semanticRows.length)}/${String(bm25Rows.length)}/${String(registryRows.length)}`,
  );

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
  HNSW_ITERATIVE_SCAN,
  SEMANTIC_SCAN_MODE,
} as const;

/** The tuning statement, for the test that pins what each mode actually sends. */
export const semanticTuningSql = semanticTuning;
