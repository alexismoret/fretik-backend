import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw "Missing DATABASE_URL env";
}

/**
 * Max concurrent read-only connections **per pod** used by the SQL tool.
 *
 * Tuning guide:
 * - This pool is reserved for the agent SQL tool. Auth, CRUD, Better Auth,
 *   and regular app queries go through @fretik/shared/db (a separate pool).
 *   So sizing here is strictly a function of "how many SQL tool calls can
 *   run in parallel per pod".
 * - Each query is capped by `statement_timeout=15s`, so a connection is
 *   held at most 15s in the worst case. Typical tool queries run in
 *   <500ms.
 *
 * Scaling strategy (Kubernetes):
 * - Horizontal: run more @fretik/ai pods via HPA. Total connections used
 *   by this pool = `pods × AI_DB_READONLY_POOL_MAX`. Must stay under
 *   Postgres `max_connections` minus what api/worker/trigger-service use.
 * - Recommended above ~3 pods: put PgBouncer (transaction mode) in front
 *   of Postgres so you can raise per-pod max safely.
 * - Prefer scaling pods over raising `max` on a single pod, because the
 *   AST parser + JS sandbox are CPU-bound — more pods = more CPU.
 */
const POOL_MAX = Number(process.env.AI_DB_READONLY_POOL_MAX ?? 10);

/**
 * Dedicated pg pool for the SQL tool. Session parameters are set via the
 * connection string `-c` options so they take effect immediately when the
 * connection is established — no race with the first query.
 */
const separator = databaseUrl.includes("?") ? "&" : "?";
const readonlyConnectionString = `${databaseUrl}${separator}options=${encodeURIComponent("-c default_transaction_read_only=on -c statement_timeout=15000")}`;

export const readonlyPool = new Pool({
  connectionString: readonlyConnectionString,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Execute a sanitized SELECT / WITH query. Caller is responsible for
 * having run `sanitizeSelect()` first.
 */
export const runReadonlyQuery = async <
  T extends object = Record<string, unknown>,
>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await readonlyPool.query<T>(sql, params);
  return result.rows;
};
