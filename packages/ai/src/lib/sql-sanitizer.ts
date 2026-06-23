import { Parser } from "node-sql-parser";

const parser = new Parser();
const PARSE_OPTIONS = { database: "postgresql" } as const;

/**
 * Tables and views the SQL tool may read. Anything else — auth/secret tables
 * (account, two_factor, …), system catalogs (pg_*, information_schema), other
 * teams' internals — is rejected before the query reaches the database. This is
 * the second line of defence: the `fretik_sql_tool` role also lacks GRANTs on
 * everything outside this set, but rejecting here gives the agent a clean,
 * actionable error instead of a Postgres permission failure.
 *
 * Identity (member names/emails) is reachable only through `chatbot_org_members`,
 * a curated view that projects safe columns and is org-scoped by RLS session
 * variable — never the raw `user`/`member` tables.
 */
// The dynamic-data graph is reached through the typed `v_*` views (the `v_`
// namespace, allowed below by prefix — never raw `object_records` / `data`) plus
// the graph relations `links` / `link_types` / `domain_events` /
// `domain_event_links` (the join + provenance path). `object_records` and
// `object_types` are deliberately ABSENT: they back the security_invoker views
// (GRANT + RLS at the DB level) but the model cannot reference them directly, so
// raw JSONB is never in its SQL surface — maximizing text-to-SQL precision.
const ALLOWED_RELATIONS = new Set([
  "documents",
  "document_properties",
  "folders",
  "labels",
  "document_labels",
  "field_definitions",
  "chatbot_org_members",
  // Dynamic-data graph (Phase 3). Typed `v_*` views are allowed by prefix.
  "links",
  "link_types",
  "domain_events",
  "domain_event_links",
]);

/**
 * Prefix of the typed-view namespace. Any relation named `v_*` (the generic
 * `v_record` + the per-type `v_<key>_<teamhex>` views) is allowed — the names
 * are slug-validated at creation (anti-DDL-injection) and the views are RLS-
 * scoped via `security_invoker`. This is how the model reads typed record data
 * without ever touching raw `object_records`.
 */
const TYPED_VIEW_PREFIX = "v_";

/**
 * Statement types allowed — strictly read-only. Every other statement type
 * (insert/update/delete/drop/create/alter/grant/...) is rejected.
 */
const ALLOWED_STATEMENTS = new Set(["select", "with"]);

/** Shape of a validation error bubbled back up to the agent. */
export interface SqlValidationError {
  code: "SQL_PARSE_FAILED" | "SQL_NOT_READ_ONLY" | "SQL_TABLE_NOT_ALLOWED";
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

/** Collect every CTE name defined by `WITH` clauses so they aren't mistaken for base tables. */
const collectCteNames = (statements: unknown[]): Set<string> => {
  const names = new Set<string>();
  for (const stmt of statements) {
    const withClause = (stmt as { with?: unknown }).with;
    if (!Array.isArray(withClause)) continue;
    for (const cte of withClause) {
      const value = (cte as { name?: { value?: string } }).name?.value;
      if (typeof value === "string") names.add(value.toLowerCase());
    }
  }
  return names;
};

/**
 * Validate + sanitize a user-supplied SQL query:
 *  1. Parse with node-sql-parser (postgresql dialect) — reject on parse error.
 *  2. Reject anything that isn't SELECT / WITH.
 *  3. Reject any relation outside the product allowlist (catches system
 *     catalogs, auth tables, and schema-qualified access).
 *
 * Team/org scoping is enforced by the database (RLS + the curated view via the
 * `fretik.team_id` / `fretik.organization_id` session variables set per query),
 * so the query no longer needs to carry a team filter.
 *
 * Returns the query ready to execute (without trailing semicolon). Throws
 * `SqlValidationException` on any failure.
 */
export const sanitizeSelect = (rawSql: string): string => {
  const sql = rawSql.trim().replace(/;$/, "");

  // 1. Parse
  let ast;
  try {
    ast = parser.astify(sql, PARSE_OPTIONS);
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

  // 3. Table allowlist. `tableList` returns "type::db::table" strings; CTE
  //    names appear here too, so subtract them. A non-public schema (db is not
  //    "null"/"public") is rejected outright — that's how `pg_catalog.*` and
  //    `information_schema.*` are blocked.
  const cteNames = collectCteNames(statements);
  let tableList: string[];
  try {
    tableList = parser.tableList(sql, PARSE_OPTIONS);
  } catch (err) {
    throw new SqlValidationException({
      code: "SQL_PARSE_FAILED",
      message: `Invalid SQL: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const entry of tableList) {
    const parts = entry.split("::");
    const schema = parts[1];
    const table = (parts[2] ?? "").toLowerCase();

    if (schema && schema !== "null" && schema !== "public") {
      throw new SqlValidationException({
        code: "SQL_TABLE_NOT_ALLOWED",
        message: `Schema "${schema}" is not accessible. Query only the product tables listed in the system prompt.`,
      });
    }

    if (
      cteNames.has(table) ||
      ALLOWED_RELATIONS.has(table) ||
      table.startsWith(TYPED_VIEW_PREFIX)
    )
      continue;

    throw new SqlValidationException({
      code: "SQL_TABLE_NOT_ALLOWED",
      message: `Table "${table}" is not accessible. Query the typed views (v_record, v_<type>) and the graph relations (links, link_types, domain_events) listed in the system prompt — never raw object_records.`,
    });
  }

  return sql;
};
