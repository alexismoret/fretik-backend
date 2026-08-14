import { tool } from "ai";
import { z } from "zod";
import {
  mapSite,
  TavilyTimeoutError,
  TavilyUnconfiguredError,
} from "../lib/tavily";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import {
  assertFetchableTarget,
  isUrlDenied,
  WebEgressError,
} from "../lib/web-egress";

/**
 * Domain tool (deferred) — discover the URLs of a site without
 * extracting any content, via Tavily's `/map` endpoint.
 *
 * The cheap half of "find the right page, then read it": mapping bills
 * ~1 credit per 10 discovered pages against 1 per 5 extracted ones,
 * and returns URLs only, so a hundred candidate pages cost a fraction
 * of a single fetch and never touch the context window. Crawl (map +
 * extract in one shot) is deliberately NOT exposed: it pulls whole
 * page bodies the model did not choose.
 */

export const createWebMapTool = () =>
  tool({
    description: [
      "List the pages of a website without reading them (URLs only).",
      "",
      "Use it when you know the site but not the page — pricing, contact, legal notice, a specific section of a documentation. Map first, pick the URL, then `webFetch` it: cheaper and far more reliable than guessing a path or fetching candidates one by one.",
      "",
      'Narrow with `select_paths` (regex on the path, e.g. `["/docs/.*"]`) when the structure is predictable. `instructions` filters semantically instead but doubles the cost — reach for it only when a path pattern cannot express the need.',
      "",
      "Returns `{ baseUrl, urls }`. An empty list means the site blocks crawling or hides its pages behind scripts — fall back to `searchWeb` restricted to that domain via `include_domains`.",
    ].join("\n"),
    inputSchema: z.object({
      url: z
        .url()
        .describe(
          "Site root or section to map, e.g. https://example.com or https://example.com/docs",
        ),
      instructions: z
        .string()
        .optional()
        .describe(
          'Natural-language filter, e.g. "pricing and plan pages". Doubles the cost — prefer `select_paths` when the path is predictable.',
        ),
      select_paths: z
        .array(z.string())
        .max(10)
        .optional()
        .describe('Regex path filters, e.g. ["/docs/.*", "/api/.*"]'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of URLs to discover (default 30)"),
    }),
    execute: async ({ url, instructions, select_paths, limit }) => {
      // Egress hardening: reject internal/private/non-http(s) targets and
      // domains excluded by the deployment's policy. See `lib/web-egress.ts`.
      try {
        assertFetchableTarget(url);
      } catch (err) {
        if (err instanceof WebEgressError) {
          return { error: err.detail.message, code: err.detail.code, url };
        }
        throw err;
      }

      try {
        const result = await mapSite(url, {
          ...(instructions === undefined ? {} : { instructions }),
          ...(select_paths === undefined ? {} : { selectPaths: select_paths }),
          ...(limit === undefined ? {} : { limit }),
        });

        return {
          baseUrl: result.baseUrl,
          // Drop URLs the deployment's domain policy would refuse to fetch, so
          // every returned URL is one `webFetch` can actually open.
          urls: result.urls.filter((u) => !isUrlDenied(u)),
        };
      } catch (err) {
        if (err instanceof TavilyTimeoutError) {
          return {
            error: `webMap timed out: ${err.message}`,
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
          error: `webMap failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.WEB_MAP_ERROR,
        };
      }
    },
  });
