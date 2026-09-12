import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import {
  fetchPages,
  WebProviderUnconfiguredError,
  WebTimeoutError,
} from "../lib/web";
import { assertFetchableTarget, WebEgressError } from "../lib/web-egress";

/**
 * Domain tool (deferred) — fetch public URLs and return their content as
 * Markdown.
 *
 * Backed by Parallel's `/v1/extract` (see `lib/web/parallel.ts`), which runs a
 * server-side headless browser: client-rendered pages read like static ones,
 * and the request leaves THEIR egress rather than our single datacenter IP,
 * which is what keeps a hosted service from collecting blocks. Unlike Claude
 * Code's `WebFetchTool` — axios, turndown, then a sub-LLM "apply prompt" pass —
 * this is one remote call returning Markdown, and the chatbot reads it itself
 * in the next step. No hidden LLM round-trip.
 *
 * Batching matters on latency, not price: 20 URLs travel in one round-trip,
 * billed per URL either way.
 *
 * Larger threshold than the other domain tools (48K vs 16K) because one article
 * easily fills 20-40 KB of Markdown and we would otherwise persist almost every
 * call into a `<persisted-output>` envelope.
 */

const WEB_FETCH_PERSIST_THRESHOLD_CHARS = 48_000;

export const createWebFetchTool = () =>
  tool({
    description: [
      "Read public web pages and return their content as Markdown.",
      "",
      "Use it for the FULL content of pages you already know — a page the user referenced, a hit `searchWeb` returned, a URL `webMap` discovered. For discovery, search first: fetching candidate URLs one by one does not scale. JavaScript-rendered pages are handled; you never need to ask for that.",
      "",
      "Pass up to 20 `urls` in ONE call when you need several related pages — they travel together, and batching also sharpens `with_images`, which tells the site's own logos and buttons apart from real illustrations by seeing what the pages have in common. Set `objective` (and `queries`) to get only the passages that answer your question instead of whole articles; set `full_content` when you need the page entire.",
      "",
      "`with_images` returns each page's illustrations, with captions, for a `::gallery`. This is the ONLY source of images — searching does not return any — so when the user wants to see something, read the pages that show it.",
      "",
      "Returns `{ results: [{ url, title, content, favicon, publishedDate, images? }], failed: [{ url, error, status? }] }` — a partial success is normal: read what came back and do not retry a URL that failed twice. A 403 means the site refuses automated reads; search for the same content elsewhere instead of retrying. Large markdown may be auto-persisted: recover with `read(file_path)` or process with `python`.",
    ].join("\n"),
    inputSchema: z.object({
      urls: z
        .array(z.url())
        .min(1)
        .max(20)
        .describe(
          "Public URLs to read (1-20). Batch related pages you will read together.",
        ),
      objective: z
        .string()
        .optional()
        .describe(
          "What you are trying to learn, in a sentence. Returns the passages that answer it instead of whole pages — prefer it on long articles and documentation.",
        ),
      queries: z
        .array(z.string().min(1))
        .max(5)
        .optional()
        .describe("Keyword queries sharpening `objective` when it is broad"),
      full_content: z
        .boolean()
        .optional()
        .describe(
          "Return each page whole instead of the passages matching `objective`. Use when you need structure or exhaustiveness, not an answer.",
        ),
      with_images: z
        .boolean()
        .optional()
        .describe(
          "Also return the images found on each page, with their captions. Set it whenever the subject is visual and you intend to show them.",
        ),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Force a live read instead of accepting recently cached content. Only for fast-moving facts — prices, availability, breaking news.",
        ),
    }),
    execute: async (
      { urls, objective, queries, full_content, with_images, fresh },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      // Egress hardening per URL: reject internal/private/non-http(s) targets
      // and domains excluded by the deployment's policy before the provider
      // call. A blocked URL joins `failed` instead of sinking the whole batch.
      // The web stays open by default; see `lib/web-egress.ts`.
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

      let result: Awaited<ReturnType<typeof fetchPages>>;
      try {
        result = await fetchPages({
          urls: fetchable,
          ...(objective === undefined ? {} : { objective }),
          ...(queries === undefined ? {} : { queries }),
          ...(full_content === undefined ? {} : { fullContent: full_content }),
          ...(with_images === undefined ? {} : { withImages: with_images }),
          ...(fresh === undefined ? {} : { fresh }),
          // Correlates this read with the searches of the same task, which the
          // provider uses to rank excerpts. Never model-supplied.
          ...(ctx.conversationId === undefined
            ? {}
            : { sessionId: ctx.conversationId }),
        });
      } catch (err) {
        if (err instanceof WebTimeoutError) {
          return {
            error: `webFetch timed out: ${err.message}`,
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
        results: result.results,
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
