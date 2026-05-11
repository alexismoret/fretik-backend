import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { extractUrls, TavilyTimeoutError } from "../lib/tavily";

/**
 * Domain tool (deferred) — fetch a single public URL and return its
 * cleaned Markdown content.
 *
 * Backed by Tavily's `/extract` endpoint (see `lib/tavily.ts`). Unlike
 * Claude Code's `WebFetchTool` which pulls HTML via axios + parses
 * with turndown + runs a sub-LLM "apply prompt" pass, this tool is
 * one remote call and returns raw Markdown. The chatbot reads/
 * summarises the content itself in the next step — no hidden LLM
 * roundtrip.
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
      "Fetch a public URL and return its cleaned Markdown content.",
      "",
      "Use this when you need the FULL content of a SPECIFIC page the user referenced (a regulation page, a press release, a carrier tariff, …). For broad discovery of external information, use `searchWeb` first — it returns titles and snippets and scales better than fetching every candidate URL.",
      "",
      "Input: a single `url` and an optional `depth` ('basic' or 'advanced'). `advanced` asks Tavily for a deeper extraction pass — slower but picks up content from JS-heavy pages. Default is 'basic'.",
      "",
      "Returns: `{ url, title, content, favicon }`. If the URL fails (404, blocked, …), the tool returns an `error` field describing the failure. Large markdown responses may be auto-persisted — recover with `read(file_path)` or process with `python`.",
    ].join("\n"),
    inputSchema: z.object({
      url: z.string().url().describe("Public URL to fetch"),
      depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "Extraction depth — 'basic' (default) is faster, 'advanced' is slower but better on JS-heavy or paywalled pages",
        ),
    }),
    execute: async ({ url, depth }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      let result: Awaited<ReturnType<typeof extractUrls>>;
      try {
        result = await extractUrls([url], depth ?? "basic");
      } catch (err) {
        if (err instanceof TavilyTimeoutError) {
          return {
            error: `webFetch timed out: ${err.message}`,
            code: "TAVILY_TIMEOUT",
          };
        }
        return {
          error: `webFetch failed: ${err instanceof Error ? err.message : String(err)}`,
          code: "WEB_FETCH_ERROR",
        };
      }

      const [extracted] = result.results;
      if (!extracted) {
        const failure = result.failed[0];
        return {
          error: failure?.error ?? `No content returned for ${url}`,
          code: "WEB_FETCH_EMPTY",
          url,
        };
      }

      const payload = {
        url: extracted.url,
        title: extracted.title,
        favicon: extracted.favicon,
        content: extracted.content,
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        WEB_FETCH_PERSIST_THRESHOLD_CHARS,
      );
    },
  });
