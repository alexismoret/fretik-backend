import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { executeSql } from "../services/sql/execute";

export const createSqlQueryTool = () =>
  tool({
    description: [
      "Execute a read-only PostgreSQL SELECT query with pagination.",
      "",
      "Results are auto-paginated (15 rows per page). If the response includes `hasMore: true`, call the tool again with the SAME `sql_query` and `offset = nextOffset` to fetch the next page. Large result sets are automatically persisted to a `<persisted-output>` file — read it back with `read(file_path)` or process it with `python`.",
      "",
      "INPUTS:",
      "- sql_query (required): PostgreSQL SELECT. MUST include the literal `__TEAM_ID__` placeholder in the WHERE clause — it is replaced server-side by the caller's team id. Any query without this placeholder is rejected.",
      "- offset (optional): pagination offset. 0 for the first page, then use the `nextOffset` from the previous response.",
      "",
      "SQL RULES:",
      "- Only SELECT / WITH. Anything else (UPDATE, DELETE, DROP, COPY, pg_*, …) is blocked.",
      "- Every query on team-scoped tables MUST include `WHERE table.team_id = '__TEAM_ID__'`.",
      "- Always add a LIMIT (default 50, max 100). No trailing semicolon.",
      "- Avoid `SELECT *` on large text columns (e.g. `markdown`) — project the specific fields you need. Returning the whole blob wastes tokens and rarely answers the question better than the projected fields would.",
      "- Prefer SQL-level filtering over returning raw blobs.",
      "",
      "On error: read the error message carefully, fix the query, retry ONCE. If it fails a second time, stop and explain to the user.",
    ].join("\n"),
    inputSchema: z.object({
      sql_query: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "PostgreSQL SELECT query. MUST include __TEAM_ID__ placeholder in WHERE clauses (server-enforced). End with LIMIT. Max 4000 chars — if you need more, rewrite as a multi-step query.",
        ),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Pagination offset. 0 for first page. Use nextOffset from previous response for subsequent pages.",
        ),
    }),
    execute: async ({ sql_query, offset }, options) => {
      const ctx = getRuntimeContext(options);
      return executeSql({
        sqlQuery: sql_query,
        teamId: ctx.teamId,
        offset,
        conversationId: ctx.conversationId,
        toolCallId: options.toolCallId,
      });
    },
  });
