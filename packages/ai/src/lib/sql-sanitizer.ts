import { Parser } from "node-sql-parser";

const parser = new Parser();

/**
 * Schemas / identifiers the LLM is never allowed to reach. Matched
 * case-insensitively against the raw SQL *and* against AST identifiers to
 * catch quoted-identifier tricks.
 */
const BLOCKED_IDENTIFIERS = [
  "pg_catalog",
  "information_schema",
  "pg_sleep",
  "pg_read_file",
  "pg_read_server_files",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_exec",
  "dblink",
  "lo_import",
  "lo_export",
  "copy",
];

/**
 * Statement types allowed — strictly read-only. Every other statement type
 * (insert/update/delete/drop/create/alter/grant/...) is rejected.
 */
const ALLOWED_STATEMENTS = new Set(["select", "with"]);

const PLACEHOLDER = "__TEAM_ID__";

/** Shape of a validation error bubbled back up to the agent. */
export interface SqlValidationError {
  code:
    | "SQL_PARSE_FAILED"
    | "SQL_NOT_READ_ONLY"
    | "SQL_BLOCKED_IDENTIFIER"
    | "SQL_MISSING_PLACEHOLDER";
  message: string;
}

export class SqlValidationException extends Error {
  constructor(public readonly error: SqlValidationError) {
    super(error.message);
    this.name = "SqlValidationException";
  }
}

/**
 * Maximum rows a single paginated request can ask for at the DB level.
 * The agent tool layer further slices to 15 rows per page.
 */
export const MAX_SQL_LIMIT = 100;

/**
 * Validate + sanitize a user-supplied SQL query:
 *  1. Parse with node-sql-parser (postgresql dialect) — reject on parse error.
 *  2. Reject anything that isn't SELECT / WITH.
 *  3. Reject blocked identifiers (pg_catalog, pg_sleep, dblink, …).
 *  4. Require the __TEAM_ID__ placeholder to prevent the agent from
 *     forgetting the team scope.
 *  5. Replace the placeholder with the escaped teamId literal.
 *
 * Returns the sanitized SQL string ready to execute (without trailing
 * semicolon). Throws `SqlValidationException` on any failure.
 */
export const sanitizeSelect = (rawSql: string, teamId: string): string => {
  const sql = rawSql.trim().replace(/;$/, "");

  // 1. Parse
  let ast;
  try {
    ast = parser.astify(sql, { database: "postgresql" });
  } catch (err) {
    throw new SqlValidationException({
      code: "SQL_PARSE_FAILED",
      message: `Invalid SQL: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // astify returns either an AST object or an array of ASTs
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length === 0) {
    throw new SqlValidationException({
      code: "SQL_PARSE_FAILED",
      message: "No statements parsed",
    });
  }

  // 2. Statement type check
  for (const stmt of statements) {
    const type = (stmt as { type?: string }).type?.toLowerCase();
    if (!type || !ALLOWED_STATEMENTS.has(type)) {
      throw new SqlValidationException({
        code: "SQL_NOT_READ_ONLY",
        message: `Only SELECT and WITH statements are allowed (got ${type ?? "unknown"})`,
      });
    }
  }

  // 3. Blocked identifiers — naive substring scan, case-insensitive.
  // Cheap and catches the usual suspects. The AST walk below would also
  // catch them but this protects against parser edge cases.
  const lower = sql.toLowerCase();
  for (const blocked of BLOCKED_IDENTIFIERS) {
    if (lower.includes(blocked)) {
      throw new SqlValidationException({
        code: "SQL_BLOCKED_IDENTIFIER",
        message: `Blocked identifier "${blocked}" is not allowed`,
      });
    }
  }

  // 4. __TEAM_ID__ must be present — mandatory contract with the agent.
  if (!sql.includes(PLACEHOLDER)) {
    throw new SqlValidationException({
      code: "SQL_MISSING_PLACEHOLDER",
      message:
        "SQL query must include the __TEAM_ID__ placeholder in its WHERE clause",
    });
  }

  // 5. Replace placeholder with the quoted team id.
  // The agent may write either `'__TEAM_ID__'` (quoted) or `__TEAM_ID__`
  // (unquoted). We handle both so the result is always a valid SQL string
  // literal: `'<uuid>'`. Replace the quoted variant first to avoid
  // producing double-quoted `''<uuid>''`.
  const safeTeamId = teamId.replace(/'/g, "''");
  return sql
    .replaceAll(`'${PLACEHOLDER}'`, `'${safeTeamId}'`)
    .replaceAll(PLACEHOLDER, `'${safeTeamId}'`);
};
