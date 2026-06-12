import { Pool } from "pg";

/**
 * Connection string for the agent SQL tool's dedicated least-privilege role
 * (`fretik_sql_tool`). This role can only SELECT an allowlist of product tables;
 * every team-scoped table is fenced by row-level security keyed on the
 * `fretik.team_id` / `fretik.organization_id` session variables set per query
 * (see `runReadonlyQuery`). It is NOT the app owner — the owner connection
 * (`DATABASE_URL`, used by `@fretik/shared/db`) bypasses RLS and must never back
 * this tool.
 *
 * Required: a missing value is a hard boot failure rather than a silent
 * fallback to `DATABASE_URL`, which would re-open cross-team reads.
 */
const readonlyUrl = process.env.AI_DB_READONLY_URL;
if (!readonlyUrl) {
  throw "Missing AI_DB_READONLY_URL env — the SQL tool requires its dedicated read-only role connection (see backend/packages/shared migration harden_sql_tool)";
}

/**
 * Max concurrent read-only connections **per pod** used by the SQL tool.
 *
 * Tuning guide:
 * - This pool is reserved for the agent SQL tool. Auth, CRUD, Better Auth,
 *   and regular app queries go through @fretik/shared/db (the owner pool).
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
 *   of Postgres. Safe here because the team/org scope is set with
 *   transaction-local `set_config(..., is_local => true)`, so it never
 *   leaks across pooled sessions.
 * - Prefer scaling pods over raising `max` on a single pod, because the
 *   AST parser + JS sandbox are CPU-bound — more pods = more CPU.
 */
const POOL_MAX = Number(process.env.AI_DB_READONLY_POOL_MAX ?? 10);

/**
 * Session parameters set via the connection string `-c` options so they take
 * effect immediately — no race with the first query. `default_transaction_read_only`
 * is defence-in-depth on top of the role's SELECT-only grants.
 */
const separator = readonlyUrl.includes("?") ? "&" : "?";
const readonlyConnectionString = `${readonlyUrl}${separator}options=${encodeURIComponent("-c default_transaction_read_only=on -c statement_timeout=15000")}`;

export const readonlyPool = new Pool({
  connectionString: readonlyConnectionString,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export interface RunReadonlyQueryArgs {
  sql: string;
  /** Current team — sets `fretik.team_id` so RLS scopes every product table. */
  teamId: string;
  /** Current org — sets `fretik.organization_id` for the identity view + field-definition templates. */
  organizationId: string;
  params?: unknown[];
}

/**
 * Execute a sanitized SELECT / WITH query as the least-privilege role inside a
 * single transaction that pins the team/org scope. Scoping is enforced by the
 * database (RLS policies + the curated `chatbot_org_members` view), so a query
 * that omits a team filter still returns only the caller's rows. Caller is
 * responsible for having run `sanitizeSelect()` first.
 */
export const runReadonlyQuery = async <
  T extends object = Record<string, unknown>,
>({
  sql,
  teamId,
  organizationId,
  params = [],
}: RunReadonlyQueryArgs): Promise<T[]> => {
  const client = await readonlyPool.connect();
  try {
    await client.query("BEGIN");
    // Transaction-local scope — `is_local => true` is the bind-parameter-safe
    // equivalent of `SET LOCAL`, so it never leaks across a pooled connection.
    await client.query(
      "SELECT set_config('fretik.team_id', $1, true), set_config('fretik.organization_id', $2, true)",
      [teamId, organizationId],
    );
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
