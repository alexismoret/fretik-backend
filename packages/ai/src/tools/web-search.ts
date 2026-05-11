import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { searchTavily, TavilyTimeoutError } from "../lib/tavily";

/**
 * Per-tool char threshold for `maybePersistLargeOutput`. Tavily
 * results are compact compared to RAG (title + 2-3 sentence snippet
 * per hit), so the envelope sits below the global 32K default. Matches
 * the `maxResultSizeChars: 24_000` on `searchWeb` in
 * `agents/chatbot/tools.ts`.
 */
const WEB_SEARCH_PERSIST_THRESHOLD_CHARS = 24_000;

export const createWebSearchTool = () =>
  tool({
    description: [
      "Search the public web via Tavily for external knowledge.",
      "",
      "Use this when:",
      "- The question is about general industry knowledge, regulations, or market information that is clearly not in team data.",
      "- The internal tools (`searchKnowledge`, `querySql`) returned nothing relevant.",
      "- The user explicitly asks for external / web information.",
      "",
      "Prefer internal tools first for questions that could plausibly be answered from the team's own database. The web is a fallback, not a default.",
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query in natural language"),
      start_date: z
        .string()
        .optional()
        .describe(
          "Optional ISO date (YYYY-MM-DD) to restrict results to pages published after this date",
        ),
    }),
    execute: async ({ query, start_date }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      try {
        const result = await searchTavily(query, {
          includeFavicon: true,
          ...(start_date ? { startDate: start_date } : {}),
        });

        const payload = {
          results: result.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            favicon: (r as { favicon?: string }).favicon,
          })),
        };

        return maybePersistLargeOutput(
          payload,
          ctx.conversationId,
          toolCallId,
          WEB_SEARCH_PERSIST_THRESHOLD_CHARS,
        );
      } catch (err) {
        if (err instanceof TavilyTimeoutError) {
          return {
            error: `Web search timed out: ${err.message}`,
            code: "TAVILY_TIMEOUT",
          };
        }
        return {
          error: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
          code: "WEB_SEARCH_ERROR",
        };
      }
    },
  });
