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
    // Surface a guiding message but not the raw Postgres error — verbatim
    // driver text leaks column/table existence and aids schema enumeration.
    // The full error is kept in server logs / the trace for debugging.
    console.error("[sql-tool] query execution failed", err);
    return {
      error:
        "Query failed to execute. Check column and table names against the schema in the system prompt, then retry. If it still fails, stop and explain to the user.",
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
