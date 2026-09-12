import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { mapSite, WebTimeoutError } from "../lib/web";
import { assertFetchableTarget, WebEgressError } from "../lib/web-egress";

/**
 * Domain tool (deferred) — discover the pages of a site without reading any of
 * them, from its own `sitemap.xml`.
 *
 * The cheap half of "find the right page, then read it", and since 2026-09
 * cheap literally: discovery reads `robots.txt` and `sitemap.xml`, two files
 * published for robots to read, so it costs nothing at all where the Tavily
 * `/map` it replaces billed ~1 credit per 10 discovered pages and doubled that
 * for semantic filtering. Both the crawl and the filter are now free, which is
 * why `select_paths` and `search` can be applied generously.
 *
 * Crawling (map + extract in one shot) is deliberately NOT exposed: it pulls
 * whole page bodies the model did not choose.
 */

export const createWebMapTool = () =>
  tool({
    description: [
      "List the pages of a website without reading them (URLs only).",
      "",
      "Use it when you know the site but not the page — pricing, contact, legal notice, a section of a documentation. Map first, pick the URL, then `webFetch` it: far more reliable than guessing a path or fetching candidates one by one. Point it at a section (`https://example.com/docs`) and it returns only what lives under it.",
      "",
      'Narrow with `search` (matches the URL and its path) or `select_paths` (regex on the path, e.g. `["/docs/.*"]`). Both are free — use them rather than raising `limit`.',
      "",
      "Returns `{ baseUrl, links: [{ url, title }] }`, where `title` is the page's path. A site that publishes no sitemap returns an error saying so — fall back to `searchWeb` with `include_domains` set to that domain, which also reaches pages a sitemap never lists.",
    ].join("\n"),
    inputSchema: z.object({
      url: z
        .url()
        .describe(
          "Site root or section to map, e.g. https://example.com or https://example.com/docs",
        ),
      search: z
        .string()
        .optional()
        .describe(
          'Keep only URLs whose address or path contains this text, e.g. "pricing"',
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
        .max(200)
        .optional()
        .describe("Maximum number of URLs to return (default 50)"),
    }),
    execute: async ({ url, search, select_paths, limit }) => {
      // Egress hardening: reject internal/private/non-http(s) targets and
      // domains excluded by the deployment's policy. Load-bearing here — unlike
      // `webFetch`, this tool's requests leave THIS process, and every redirect
      // hop is re-validated in `lib/web/http.ts`.
      try {
        assertFetchableTarget(url);
      } catch (err) {
        if (err instanceof WebEgressError) {
          return { error: err.detail.message, code: err.detail.code, url };
        }
        throw err;
      }

      try {
        const result = await mapSite({
          url,
          ...(search === undefined ? {} : { search }),
          ...(select_paths === undefined ? {} : { selectPaths: select_paths }),
          ...(limit === undefined ? {} : { limit }),
        });

        if (result.links.length === 0) {
          return {
            error: `No sitemap found for ${url}, or it lists no page matching the filters.`,
            code: TOOL_ERROR_CODES.WEB_MAP_NO_SITEMAP,
            hint: `Search the domain instead: searchWeb({ queries: ["..."], include_domains: ["${new URL(url).hostname}"] })`,
          };
        }

        return { baseUrl: result.baseUrl, links: result.links };
      } catch (err) {
        if (err instanceof WebTimeoutError) {
          return {
            error: `webMap timed out: ${err.message}`,
            code: TOOL_ERROR_CODES.WEB_TIMEOUT,
          };
        }
        return {
          error: `webMap failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.WEB_MAP_ERROR,
        };
      }
    },
  });
