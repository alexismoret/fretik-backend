import { runReadonlyQuery } from "../../lib/db-readonly";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../../lib/persisted-output";
import {
  sanitizeSelect,
  SqlValidationException,
} from "../../lib/sql-sanitizer";

/**
 * Rows returned per "page" of a single tool call. Keeping this small
 * protects the LLM context window from being blown by one query.
 */
const PAGE_SIZE = 15;

/**
 * Postgres SQLSTATE classes whose message is safe AND actionable to hand back
 * to the agent: a wrong column/table/function name, a syntax slip, a type
 * mismatch, an ambiguous column. Showing these lets the model fix the query in
 * one retry; everything else (permissions, internal) stays a generic message.
 */
const FIXABLE_SQLSTATE = new Set([
  "42703", // undefined_column
  "42P01", // undefined_table
  "42883", // undefined_function
  "42601", // syntax_error
  "42804", // datatype_mismatch
  "42702", // ambiguous_column
  "42P18", // indeterminate_datatype
  "22P02", // invalid_text_representation (bad cast literal)
]);

/** Return the Postgres error message when it is an agent-fixable class, else null. */
export const fixableSqlError = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const code =
    "code" in err && typeof err.code === "string" ? err.code : undefined;
  const message =
    "message" in err && typeof err.message === "string"
      ? err.message
      : undefined;
  if (!message || !code || !FIXABLE_SQLSTATE.has(code)) return null;
  const trimmed = message.trim().replace(/\s+/g, " ").slice(0, 200);
  const base = trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
  // Postgres often names the intended column/table in `hint` (e.g. "Perhaps you
  // meant to reference the column …") — the most actionable signal for a
  // mistyped name, so the model stops guessing. Append it when present.
  const hint =
    "hint" in err && typeof err.hint === "string" ? err.hint.trim() : "";
  return hint ? `${base} ${hint.replace(/\s+/g, " ").slice(0, 160)}` : base;
};

export interface ExecuteSqlArgs {
  sqlQuery: string;
  teamId: string;
  organizationId: string;
  offset?: number;
  conversationId?: string;
  toolCallId: string;
}

export interface ExecuteSqlResult {
  rows: unknown[];
  hasMore: boolean;
  nextOffset: number | null;
  totalReturned: number;
}

export interface ExecuteSqlError {
  error: string;
  code?: string;
}

/**
 * Run a sanitized SELECT query on behalf of the agent with pagination.
 * Never throws — always returns a structured object so the LLM sees
 * the error message as a normal tool output. When the payload is
 * larger than `DOMAIN_TOOL_THRESHOLD_CHARS`, the full result is
 * written to `/workspace/outputs/persisted/{toolCallId}.json` (via the
 * conversation-storage façade) and a `<persisted-output>` envelope
 * string is returned instead so the model can read the file back via
 * `read` or process it programmatically via `python`.
 */
export const executeSql = async (
  args: ExecuteSqlArgs,
): Promise<ExecuteSqlResult | ExecuteSqlError | string> => {
  const offset = Math.max(0, args.offset ?? 0);

  // 1. Validate + sanitize
  let sanitizedSql: string;
  try {
    sanitizedSql = sanitizeSelect(args.sqlQuery);
  } catch (err) {
    if (err instanceof SqlValidationException) {
      return { error: err.error.message, code: err.error.code };
    }
    return {
      error: err instanceof Error ? err.message : String(err),
      code: "SQL_VALIDATION_ERROR",
    };
  }

  // 2. Wrap with pagination — fetch PAGE_SIZE + 1 to detect hasMore.
  const paginated = `SELECT * FROM (${sanitizedSql}) AS __page_sub OFFSET ${offset} LIMIT ${PAGE_SIZE + 1}`;

  let rows: Record<string, unknown>[];
  try {
    rows = await runReadonlyQuery({
      sql: paginated,
      teamId: args.teamId,
      organizationId: args.organizationId,
    });
  } catch (err) {
    console.error("[sql-tool] query execution failed", err);
    // Surface the Postgres message for the agent-fixable classes (a wrong
    // column/table/function name, a syntax or type slip) so the model can
    // correct it in one retry instead of guessing. Other classes stay generic
    // (no schema enumeration beyond what the query already named).
    const detail = fixableSqlError(err);
    return {
      error: detail
        ? `Query failed: ${detail} Check the column and table names against the schema in <database_schema> / <team_objects>, then retry once.`
        : "Query failed to execute. Check column and table names against the schema in the system prompt, then retry. If it still fails, stop and explain to the user.",
      code: "SQL_EXECUTION_ERROR",
    };
  }

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const result: ExecuteSqlResult = {
    rows: pageRows,
    hasMore,
    nextOffset: hasMore ? offset + PAGE_SIZE : null,
    totalReturned: pageRows.length,
  };

  // SQL queries are domain reads (rows of metadata / extracted_data),
  // so they share the tighter domain-tool cap. Tighter than the global
  // 32K default to nudge agents into pagination instead of digesting a
  // huge JSON dump inline.
  return maybePersistLargeOutput(
    result,
    args.conversationId,
    args.toolCallId,
    DOMAIN_TOOL_THRESHOLD_CHARS,
  );
};
