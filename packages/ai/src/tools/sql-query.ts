import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { executeSql } from "../services/sql/execute";

export const createSqlQueryTool = () =>
  tool({
    description: [
      "Read-only PostgreSQL SELECT against the team's database. Auto-paginated 15 rows per page.",
      "",
      "Usage:",
      "- Use for counts, sums, group-by, ranking, filtering by exact field values (status, foreign keys, date ranges, dynamic field values).",
      "- For prose content of a document → use `searchKnowledge` instead.",
      "- For paginated browse of documents / entities by metadata → use `listDocuments` / `listEntities` instead (they wrap the right query).",
      "- `sql_query` MUST include the literal `__TEAM_ID__` placeholder in the WHERE clause — server-substituted. No trailing semicolon. Always add LIMIT (default 50, max 100).",
      "- Only SELECT / WITH. INSERT, UPDATE, DELETE, DROP, COPY, pg_* are blocked.",
      "- Project the specific fields you need rather than `SELECT *`.",
      "- For document attribute filters (any field the team has configured), JOIN `document_field_values dfv ON dfv.document_id = d.id AND dfv.field_key = '<key>'` and compare `dfv.value` as JSONB (`= '\"v\"'::jsonb` for scalars, `@> '\"v\"'::jsonb` for `multi_select` containment). Available `field_key` values are listed in `<team_fields>` in the system prompt — never invent a key.",
      "- `offset`: 0 for first page, then `nextOffset` from previous response.",
      "- On error: read the message, fix once, retry. If it still fails, stop and explain to the user.",
      "",
      "Large result sets are auto-persisted to a `<persisted-output>` file — read it back with `read(file_path)` or process it with `python`.",
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
