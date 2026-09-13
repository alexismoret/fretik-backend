import { describe, expect, test } from "bun:test";
import { WebConstraintUnsupportedError } from "../../../src/lib/web/errors";
import { parallelSearch } from "../../../src/lib/web/parallel";
import type { WebSearchRequest } from "../../../src/lib/web/types";

/**
 * The two search providers are NOT interchangeable, and the fallback is the
 * place that would pretend they are.
 *
 * Perplexity's `mode` picks a corpus — `sec` means filings, `academic` means
 * papers — and `crawledAfter` bounds how recently a page was re-read. Parallel
 * has neither. Dropping them and answering anyway returns ordinary web pages
 * to a question about filings, or months-old pages to one that asked for fresh
 * ones, with nothing in the result saying so. That is the failure this suite
 * exists to prevent, because it is invisible at every later layer.
 *
 * No network: every case throws before the client is built.
 */
describe("parallelSearch constraint guard", () => {
  const request = (extra: Partial<WebSearchRequest>): WebSearchRequest => ({
    queries: ["anything"],
    depth: "quick",
    ...extra,
  });

  const refusedFor = async (extra: Partial<WebSearchRequest>) => {
    try {
      await parallelSearch(request(extra));
    } catch (err) {
      return err;
    }
    return null;
  };

  test.each([
    ["an academic corpus", { mode: "academic" as const }, "academic"],
    ["an SEC corpus", { mode: "sec" as const }, "sec"],
    ["a crawl-date bound", { crawledAfter: "2026-01-01" }, "crawled_after"],
    ["a language filter", { languages: ["fr"] }, "languages"],
  ])("refuses %s rather than dropping it", async (_label, extra, needle) => {
    const err = await refusedFor(extra);
    expect(err).toBeInstanceOf(WebConstraintUnsupportedError);
    expect((err as Error).message).toContain(needle);
  });

  /**
   * `mode: "web"` and an empty language list are the ABSENCE of a constraint,
   * not a constraint Parallel cannot meet — refusing them would take the
   * fallback out of service for ordinary searches, which is the whole point of
   * having one.
   */
  test.each([
    ["an explicit web mode", { mode: "web" as const }],
    ["an empty language list", { languages: [] }],
  ])("does not refuse %s", async (_label, extra) => {
    const err = await refusedFor(extra);
    expect(err).not.toBeInstanceOf(WebConstraintUnsupportedError);
  });
});
