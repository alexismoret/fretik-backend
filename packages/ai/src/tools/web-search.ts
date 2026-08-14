import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import {
  searchTavily,
  TavilyTimeoutError,
  TavilyUnconfiguredError,
} from "../lib/tavily";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { isUrlDenied } from "../lib/web-egress";

/**
 * Per-tool char threshold for `maybePersistLargeOutput`. Tavily results are
 * compact compared to RAG (title + 2-3 sentence snippet per hit), so the
 * envelope can sit low. This is the ONLY cap that actually fires: the registry
 * metadata that used to declare one was read by nothing and has been removed.
 */
const WEB_SEARCH_PERSIST_THRESHOLD_CHARS = 24_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const createWebSearchTool = () =>
  tool({
    description: [
      "Search the public web via Tavily.",
      "",
      "Search whenever you are not certain, whatever the subject — any figure, date, price, name, rule, or product behaviour you would otherwise answer from memory. Training data is stale by construction, and a confident wrong answer costs the user more than a search. Answer without searching only when no external fact is involved (reasoning, writing, arithmetic, formatting) or when the fact belongs to the team's own data, which the web does not hold (`searchKnowledge` / `querySql`).",
      "",
      "Tune the call to the question: `topic: 'news'` for current events (hits then carry a publication date), `'finance'` for markets and listed companies; `time_range` or `start_date`/`end_date` to bound recency; `include_domains` to restrict to sources you trust; `include_images` whenever the subject is visual, and show what comes back in a `::gallery`. `search_depth: 'advanced'` costs twice as much — use it only when a basic search came back shallow.",
      "",
      "Returns per hit: `title`, `url`, `content` (snippet), `score`, `favicon`, and `publishedDate` when the source exposes one, plus top-level `images` when requested. Cite every claim with `[Page title](URL)`.",
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query in natural language"),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .describe(
          "Search vertical — 'news' for current events, 'finance' for markets and listed companies. Default 'general'.",
        ),
      search_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "'advanced' digs deeper for twice the cost — only after a 'basic' search came back shallow. Default 'basic'.",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of hits to return (default 5)"),
      time_range: z
        .enum(["day", "week", "month", "year"])
        .optional()
        .describe(
          "Restrict to pages published within the last day/week/month/year",
        ),
      start_date: z
        .string()
        .regex(ISO_DATE)
        .optional()
        .describe("Only pages published on or after this date (YYYY-MM-DD)"),
      end_date: z
        .string()
        .regex(ISO_DATE)
        .optional()
        .describe("Only pages published on or before this date (YYYY-MM-DD)"),
      include_domains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe(
          'Restrict results to these sites, e.g. ["legifrance.gouv.fr"]. Wildcards like "*.example.com" work.',
        ),
      exclude_domains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Drop these sites from the results"),
      include_images: z
        .boolean()
        .optional()
        .describe(
          "Also return related images with descriptions. Set it whenever the subject is visual — a place, a product, a person, a work, an event — without waiting to be asked",
        ),
    }),
    execute: async (
      {
        query,
        topic,
        search_depth,
        max_results,
        time_range,
        start_date,
        end_date,
        include_domains,
        exclude_domains,
        include_images,
      },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      try {
        const result = await searchTavily(query, {
          includeFavicon: true,
          ...(topic === undefined ? {} : { topic }),
          ...(search_depth === undefined ? {} : { searchDepth: search_depth }),
          ...(max_results === undefined ? {} : { maxResults: max_results }),
          ...(time_range === undefined ? {} : { timeRange: time_range }),
          ...(start_date === undefined ? {} : { startDate: start_date }),
          ...(end_date === undefined ? {} : { endDate: end_date }),
          ...(include_domains === undefined
            ? {}
            : { includeDomains: include_domains }),
          ...(exclude_domains === undefined
            ? {}
            : { excludeDomains: exclude_domains }),
          ...(include_images === true
            ? { includeImages: true, includeImageDescriptions: true }
            : {}),
        });

        // Drop hits whose host the deployment's domain policy would refuse to
        // fetch (no-op when neither list is set) so the model is never nudged
        // toward a page it cannot open. See `lib/web-egress.ts`.
        const images = (result.images ?? []).filter((i) => !isUrlDenied(i.url));
        const payload = {
          results: result.results
            .filter((r) => !isUrlDenied(r.url))
            .map((r) => ({
              title: r.title,
              url: r.url,
              content: r.content,
              score: r.score,
              favicon: r.favicon,
              publishedDate: r.publishedDate,
            })),
          ...(images.length > 0 ? { images } : {}),
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
            code: TOOL_ERROR_CODES.TAVILY_TIMEOUT,
          };
        }
        if (err instanceof TavilyUnconfiguredError) {
          return {
            error: err.message,
            code: TOOL_ERROR_CODES.WEB_TOOLS_UNCONFIGURED,
          };
        }
        return {
          error: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.WEB_SEARCH_ERROR,
        };
      }
    },
  });
