-- Make the HNSW index on `ai_vectors.embedding` reachable by the planner.
--
-- It was never used. Not broken, not missing, not mis-tuned: present, valid,
-- 167 MB, `halfvec_cosine_ops` — and priced at 97 730 against a Seq Scan's
-- 3 310, a ~30x overestimate, so the planner never picked it. Every broad
-- semantic search was therefore an exact brute-force scan, 260-385 ms server
-- side on 20 504 rows, growing LINEARLY with the corpus.
--
-- The cause is a cost, not a hint. `cosine_distance(halfvec, halfvec)` carries
-- pgvector's default `procost = 1`, so Postgres prices 20 000 distance
-- computations over 2 560 dimensions the way it prices 20 000 integer
-- additions. Under that arithmetic a Seq Scan genuinely looks cheaper, and no
-- amount of `enable_seqscan`/`ef_search` tuning changes the CHOICE — three such
-- attempts were measured and are recorded in `packages/ai/evals/RUNBOOK.md`,
-- one of which silently returned 8 rows for a LIMIT 150.
--
-- Only the `halfvec` overload is touched: it is the sole operator behind
-- `idx_ai_vectors_embedding_hnsw`. The `vector` and `sparsevec` variants are
-- left at their defaults because nothing in this schema queries through them,
-- and a cost is a statement about a plan, not a courtesy.
--
-- The application role owns the pgvector functions here, so `ALTER FUNCTION`
-- succeeds without superuser. It is also NOT permanent in the way a column is:
-- `ALTER EXTENSION vector UPDATE` reinstalls the catalog entry and resets
-- `procost` to 1. That is why the AI service checks it at boot
-- (`warnIfVectorPlannerMiscosted`) rather than trusting that this file ran once.
--
-- Measured after, same query shape, same scope predicate: 150/150 rows in
-- 8-9 ms warm, 75-80 ms cold.
--
-- ---------------------------------------------------------------------------
-- DO NOT APPLY THIS FILE AHEAD OF THE QUERY-SIDE GUCs. It is not independently
-- safe, and the failure is silent.
--
-- Once the planner CAN pick the index, it does — and a filtered HNSW scan stops
-- after `ef_search` candidates. At the `hnsw.ef_search = 100` this codebase set
-- before that change, against `PER_SEARCH_LIMIT = 150`, the knowledge arm was
-- measured returning **8 rows instead of 150** (`packages/ai/evals/RUNBOOK.md`).
-- Nothing errors: retrieval simply gets a fraction of its candidate pool and
-- recall degrades. This migration therefore ships together with
-- `hnsw.iterative_scan = strict_order` + `hnsw.ef_search = 200`, set per
-- statement in `packages/ai/src/services/search/hybrid-search.ts` — per
-- statement and not as a database default, because a default would also apply
-- to sessions that want the old plan.
--
-- The rollback for the pair is `SEMANTIC_SCAN_MODE=seqscan` (read in that same
-- file), which asks for the pre-2026-09-10 plan without reverting anything.
-- ---------------------------------------------------------------------------
ALTER FUNCTION cosine_distance(halfvec, halfvec) COST 100;
--> statement-breakpoint
-- Optional, and deliberately non-fatal. `pg_prewarm` lets the jobs service pull
-- the index into shared buffers after a restart, which is the difference between
-- the 8 ms warm figure and the 75 ms cold one. Creating an extension needs
-- privileges a managed Postgres may not grant, and a migration that cannot be
-- applied is a crash loop behind the healthcheck for a nice-to-have — so it
-- warns and continues.
--
-- `WHEN OTHERS`, not `WHEN insufficient_privilege`, and the difference is the
-- whole point: a server whose contrib package is simply absent raises
-- `undefined_file` (58P01), not `42501`. Catching only the privilege case would
-- let the far more likely failure abort the migration — and via
-- `assertMigrationsCurrent()` that is a crash loop across all three services,
-- which is exactly what this block exists to prevent. Measured: `pg_prewarm` is
-- NOT installed on dev, where only `vector` is.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_prewarm;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'pg_prewarm not installed (%) — the vector index stays cold after a restart; see backend/docs/OPERATIONS.md §9', SQLERRM;
END $$;
--> statement-breakpoint
-- `ai_vectors` has never been analyzed by anything but autoanalyze
-- (`last_analyze` was empty). The planner is about to be asked to choose
-- differently; give it current statistics to choose from.
ANALYZE ai_vectors;
