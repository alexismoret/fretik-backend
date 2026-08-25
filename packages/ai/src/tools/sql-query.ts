import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { executeSql } from "../services/sql/execute";

export const createSqlQueryTool = () =>
  tool({
    description: [
      "Read-only PostgreSQL SELECT against the team's database. Auto-paginated 15 rows per page. Rows are automatically scoped to the current team — no team filter needed.",
      "",
      "Usage:",
      "- Use for counts, sums, group-by, ranking, filtering by exact field values (status, foreign keys, date ranges, dynamic field values).",
      "- For prose content of a document → use `searchKnowledge` instead.",
      "- For paginated browse of documents by metadata → use `listDocuments` instead (it wraps the right query).",
      "- Only SELECT / WITH, and only the tables in `<database_schema>`. No trailing semicolon. Always add LIMIT (default 50, max 100).",
      "- A collection's columns are already in `<team_collections>` (or call `describeCollection`) — never probe `information_schema` / `pg_catalog` (blocked).",
      "- Project the specific fields you need rather than `SELECT *`.",
      "- To attribute rows to a member (uploader, author), JOIN `chatbot_org_members m ON m.user_id = d.uploaded_by_id` for their `name`/`email`.",
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
          "PostgreSQL SELECT query, scoped to the current team automatically. End with LIMIT. Max 4000 chars — if you need more, rewrite as a multi-step query.",
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
        organizationId: ctx.organizationId,
        offset,
        conversationId: ctx.conversationId,
        toolCallId: options.toolCallId,
      });
    },
  });
