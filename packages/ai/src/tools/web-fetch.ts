import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import {
  extractUrls,
  TavilyTimeoutError,
  TavilyUnconfiguredError,
} from "../lib/tavily";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { assertFetchableTarget, WebEgressError } from "../lib/web-egress";

/**
 * Domain tool (deferred) — fetch public URLs and return their cleaned
 * Markdown content.
 *
 * Backed by Tavily's `/extract` endpoint (see `lib/tavily.ts`). Unlike
 * Claude Code's `WebFetchTool` which pulls HTML via axios + parses
 * with turndown + runs a sub-LLM "apply prompt" pass, this tool is
 * one remote call and returns raw Markdown. The chatbot reads/
 * summarises the content itself in the next step — no hidden LLM
 * roundtrip.
 *
 * Batching matters on cost: Tavily bills `/extract` per group of 5
 * URLs, so five pages in one call cost what one page costs.
 *
 * Larger than the other domain tools (48K threshold vs 16K) because a
 * single article can easily fill 20-40 KB of Markdown and we would
 * otherwise persist almost every call into a `<persisted-output>`
 * envelope. Tuned to match the `webFetch` entry in
 * `keyDecisions.persistedOutputThreshold` (48K).
 */

const WEB_FETCH_PERSIST_THRESHOLD_CHARS = 48_000;

export const createWebFetchTool = () =>
  tool({
    description: [
      "Fetch public URLs and return their cleaned Markdown content.",
      "",
      "Use it for the FULL content of pages you already know — a page the user referenced, a hit `searchWeb` returned, a URL `webMap` discovered. For discovery, search first: fetching candidate URLs one by one does not scale.",
      "",
      "Pass up to 5 `urls` in ONE call when you need several related pages — Tavily bills per group of 5, so five URLs together cost what one costs. Set `query` on long pages to get only the passages that answer it instead of the whole article. `depth: 'advanced'` is slower but reads JS-heavy pages.",
      "",
      "Returns `{ results: [{ url, title, content, favicon }], failed: [{ url, error }] }` — a partial success is normal, read what came back and do not retry a URL that failed twice. Large markdown may be auto-persisted: recover with `read(file_path)` or process with `python`.",
    ].join("\n"),
    inputSchema: z.object({
      urls: z
        .array(z.url())
        .min(1)
        .max(5)
        .describe(
          "Public URLs to fetch (1-5). Batch related pages you will read together.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Return only the passages relevant to this question instead of the full page — prefer it on long articles and documentation",
        ),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("With `query`: passages returned per page (default 3)"),
      depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "Extraction depth — 'basic' (default) is faster, 'advanced' is slower but better on JS-heavy or paywalled pages",
        ),
    }),
    execute: async ({ urls, query, chunks_per_source, depth }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      // Egress hardening per URL: reject internal/private/non-http(s) targets
      // and domains excluded by the deployment's denylist/allowlist before the
      // Tavily call. A blocked URL joins `failed` instead of sinking the whole
      // batch. The web stays open by default; see `lib/web-egress.ts`.
      const fetchable: string[] = [];
      const blocked: Array<{ url: string; error: string }> = [];
      for (const url of urls) {
        try {
          assertFetchableTarget(url);
          fetchable.push(url);
        } catch (err) {
          if (err instanceof WebEgressError) {
            blocked.push({ url, error: err.detail.message });
            continue;
          }
          throw err;
        }
      }

      if (fetchable.length === 0) {
        return {
          error: blocked[0]?.error ?? "No fetchable URL",
          code: TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
          failed: blocked,
        };
      }

      let result: Awaited<ReturnType<typeof extractUrls>>;
      try {
        result = await extractUrls(fetchable, {
          depth: depth ?? "basic",
          ...(query === undefined ? {} : { query }),
          ...(chunks_per_source === undefined
            ? {}
            : { chunksPerSource: chunks_per_source }),
        });
      } catch (err) {
        if (err instanceof TavilyTimeoutError) {
          return {
            error: `webFetch timed out: ${err.message}`,
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
          error: `webFetch failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.WEB_FETCH_ERROR,
        };
      }

      const failed = [...blocked, ...result.failed];
      if (result.results.length === 0) {
        return {
          error: failed[0]?.error ?? `No content returned for ${urls[0]}`,
          code: TOOL_ERROR_CODES.WEB_FETCH_EMPTY,
          failed,
        };
      }

      const payload = {
        results: result.results.map((r) => ({
          url: r.url,
          title: r.title,
          favicon: r.favicon,
          content: r.content,
        })),
        ...(failed.length > 0 ? { failed } : {}),
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        WEB_FETCH_PERSIST_THRESHOLD_CHARS,
      );
    },
  });
