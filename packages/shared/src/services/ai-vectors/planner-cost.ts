/**
 * Boot-time check that the planner can still reach the HNSW index.
 *
 * The `hnsw_planner_cost` migration raises `cosine_distance(halfvec, halfvec)`
 * from pgvector's default `procost = 1` to 100, because at 1 Postgres prices
 * 20 000 distance computations over 2 560 dimensions like 20 000 integer
 * additions, decides a Seq Scan is cheaper, and never uses the index — a
 * 260-385 ms exact brute-force scan that grows linearly with the corpus.
 *
 * A migration would normally be the end of it. This one is not, because
 * `ALTER EXTENSION vector UPDATE` reinstalls the catalog entry and silently
 * puts the cost back to 1. Nothing fails when that happens: answers stay
 * correct (brute force IS exact KNN), the eval still passes, and the only
 * symptom is that retrieval slowly gets slower as the table grows. That is a
 * regression with no error to catch, so it is checked on every boot instead.
 *
 * Never fatal. A service that can serve is worth more than a service that
 * refuses to start over a plan choice, and the operator remedy is one
 * statement — see `backend/docs/OPERATIONS.md`.
 */

import { sql } from "drizzle-orm";
import db from "../../db";

/** What the migration sets. Below this, the planner goes back to Seq Scan. */
export const VECTOR_OPERATOR_MIN_COST = 100;

interface ProcRow extends Record<string, unknown> {
  procost: number;
}

/**
 * Read `pg_proc.procost` for the halfvec cosine operator and complain if it has
 * been reset. Returns the cost it found, or `null` when the function is absent
 * (pgvector not installed — the vector features are already unavailable and
 * will say so themselves).
 */
export const warnIfVectorPlannerMiscosted = async (): Promise<
  number | null
> => {
  const result = await db.execute<ProcRow>(sql`
    SELECT p.procost::float8 AS procost
    FROM pg_proc p
    JOIN pg_type a ON a.oid = p.proargtypes[0]
    WHERE p.proname = 'cosine_distance' AND a.typname = 'halfvec'
    LIMIT 1
  `);
  const procost = result.rows[0]?.procost ?? null;
  if (procost === null) {
    console.warn(
      "[vector-planner] cosine_distance(halfvec, halfvec) not found — pgvector missing?",
    );
    return null;
  }
  if (procost < VECTOR_OPERATOR_MIN_COST) {
    console.error(
      `[vector-planner] cosine_distance(halfvec, halfvec) procost=${procost.toString()} ` +
        `(expected >= ${VECTOR_OPERATOR_MIN_COST.toString()}) — the HNSW index will NOT be used and every ` +
        `broad semantic search is an exact scan. Most likely cause: ALTER EXTENSION vector UPDATE ` +
        `reset it. Fix: ALTER FUNCTION cosine_distance(halfvec, halfvec) COST 100;`,
    );
  }
  return procost;
};
