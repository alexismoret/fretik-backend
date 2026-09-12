import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import {
  searchWeb,
  WebProviderUnconfiguredError,
  WebTimeoutError,
} from "../lib/web";

/**
 * Per-tool char threshold for `maybePersistLargeOutput`. Search results are
 * compact compared to RAG (title + snippet per hit), so the envelope can sit
 * low. This is the ONLY cap that actually fires.
 */
const WEB_SEARCH_PERSIST_THRESHOLD_CHARS = 24_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const createWebSearchTool = () =>
  tool({
    description: [
      "Search the public web.",
      "",
      "Search whenever you are not certain, whatever the subject — any figure, date, price, name, rule, or product behaviour you would otherwise answer from memory. Training data is stale by construction, and a confident wrong answer costs the user more than a search. Answer without searching only when no external fact is involved (reasoning, writing, arithmetic, formatting) or when the fact belongs to the team's own data, which the web does not hold (`searchKnowledge` / `querySql`).",
      "",
      "Pass 2-3 phrasings of the SAME question in `queries` — they run as one search, for one price, and fusing them finds sources a single wording misses. Use separate calls only for genuinely different questions.",
      "",
      "Tune the rest to the question: `depth` trades content per result against speed at NO extra cost, so raise it when snippets came back thin and lower it for a quick lookup; `recency` or `published_after`/`published_before` to bound time; `include_domains` to trust specific sources; `mode: 'academic'` for research, standards and publications, `'sec'` for the regulatory filings of listed companies; `languages` when the answer lives in a language other than the question's.",
      "",
      "Returns per hit: `title`, `url`, `content` (the source's own words), `favicon`, and `publishedDate` when exposed. Cite every claim with `[Page title](URL)`. Set `include_images` whenever the subject is visual — a place, a product, a person, a work, an event — and show what comes back in a `::gallery`, without waiting to be asked.",
    ].join("\n"),
    inputSchema: z.object({
      queries: z
        .array(z.string().min(1))
        .min(1)
        .max(5)
        .describe(
          "1-5 phrasings of the same question, 3-8 words each. Give 2-3: one call, one price, better recall.",
        ),
      depth: z
        .enum(["quick", "standard", "deep"])
        .optional()
        .describe(
          "Content returned per result. Same price at every level — pick on need, not budget. Default 'standard'.",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of hits to return (default 10)"),
      recency: z
        .enum(["hour", "day", "week", "month", "year"])
        .optional()
        .describe(
          "Restrict to pages published within the last hour/day/week/month/year",
        ),
      published_after: z
        .string()
        .regex(ISO_DATE)
        .optional()
        .describe("Only pages published on or after this date (YYYY-MM-DD)"),
      published_before: z
        .string()
        .regex(ISO_DATE)
        .optional()
        .describe("Only pages published on or before this date (YYYY-MM-DD)"),
      include_domains: z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          'Restrict results to these sites, e.g. ["legifrance.gouv.fr"]',
        ),
      exclude_domains: z
        .array(z.string())
        .max(20)
        .optional()
        .describe("Drop these sites from the results"),
      mode: z
        .enum(["web", "academic", "sec"])
        .optional()
        .describe(
          "Index to search — 'academic' for papers, standards and research, 'sec' for the filings of US-listed companies. Default 'web'.",
        ),
      languages: z
        .array(z.string().min(2).max(5))
        .max(5)
        .optional()
        .describe(
          'ISO 639-1 codes restricting the language of the sources, e.g. ["fr"]',
        ),
      country: z
        .string()
        .length(2)
        .optional()
        .describe(
          'ISO 3166-1 alpha-2 country code for geo-targeted results, e.g. "FR"',
        ),
      include_images: z
        .boolean()
        .optional()
        .describe(
          "Also return images, taken from the pages the search found. Set it whenever the subject is visual.",
        ),
    }),
    execute: async (
      {
        queries,
        depth,
        max_results,
        recency,
        published_after,
        published_before,
        include_domains,
        exclude_domains,
        mode,
        languages,
        country,
        include_images,
      },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      try {
        const result = await searchWeb({
          queries,
          depth: depth ?? "standard",
          ...(max_results === undefined ? {} : { maxResults: max_results }),
          ...(recency === undefined ? {} : { recency }),
          ...(published_after === undefined
            ? {}
            : { publishedAfter: published_after }),
          ...(published_before === undefined
            ? {}
            : { publishedBefore: published_before }),
          ...(include_domains === undefined
            ? {}
            : { includeDomains: include_domains }),
          ...(exclude_domains === undefined
            ? {}
            : { excludeDomains: exclude_domains }),
          ...(mode === undefined ? {} : { mode }),
          ...(languages === undefined ? {} : { languages }),
          ...(country === undefined ? {} : { country }),
          ...(include_images === undefined
            ? {}
            : { includeImages: include_images }),
        });

        const payload = {
          results: result.results,
          ...(result.images.length > 0 ? { images: result.images } : {}),
        };

        return maybePersistLargeOutput(
          payload,
          ctx.conversationId,
          toolCallId,
          WEB_SEARCH_PERSIST_THRESHOLD_CHARS,
        );
      } catch (err) {
        if (err instanceof WebTimeoutError) {
          return {
            error: `Web search timed out: ${err.message}`,
            code: TOOL_ERROR_CODES.WEB_TIMEOUT,
          };
        }
        if (err instanceof WebProviderUnconfiguredError) {
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
