import { afterEach, describe, expect, test } from "bun:test";
import {
  applyPublishedBefore,
  faviconFor,
  joinExcerpts,
  matchesSelectPaths,
  normalizeDate,
  recencyToAfterDate,
} from "../../../src/lib/web/normalize";

/**
 * The normalisation layer is what makes a hit look the same to the model and
 * to the UI whichever provider produced it. Every function here exists because
 * a provider does NOT return something the contract promises — so these tests
 * are the contract.
 */

const ORIGINAL_FAVICON_SERVICE = process.env.AI_WEB_FAVICON_SERVICE;

afterEach(() => {
  if (ORIGINAL_FAVICON_SERVICE === undefined) {
    delete process.env.AI_WEB_FAVICON_SERVICE;
  } else {
    process.env.AI_WEB_FAVICON_SERVICE = ORIGINAL_FAVICON_SERVICE;
  }
});

describe("faviconFor", () => {
  test("substitutes the host into the configured template", () => {
    process.env.AI_WEB_FAVICON_SERVICE = "https://icons.test/{host}.ico";
    expect(faviconFor("https://example.com/a/b?c=1")).toBe(
      "https://icons.test/example.com.ico",
    );
  });

  /**
   * The operator lever that matters: the favicon request is issued by the
   * USER'S browser, so a deployment that does not want its users' browsing
   * touching a third party must be able to emit none at all.
   */
  test("emits nothing when the operator empties the service", () => {
    process.env.AI_WEB_FAVICON_SERVICE = "";
    expect(faviconFor("https://example.com")).toBeNull();
  });

  test("answers null rather than a broken URL when the host is unparseable", () => {
    process.env.AI_WEB_FAVICON_SERVICE = "https://icons.test/{host}.ico";
    expect(faviconFor("not a url")).toBeNull();
  });
});

describe("joinExcerpts", () => {
  /**
   * The elision marker is load-bearing, not decoration: without it two
   * unrelated passages read as one continuous quotation and get cited as
   * contiguous source text.
   */
  test("separates passages with an elision marker", () => {
    expect(joinExcerpts(["first", "second"])).toBe("first\n\n[...]\n\nsecond");
  });

  test("drops empty passages instead of emitting stray markers", () => {
    expect(joinExcerpts(["first", "   ", ""])).toBe("first");
  });
});

describe("normalizeDate", () => {
  test("reduces any parseable date to YYYY-MM-DD", () => {
    expect(normalizeDate("2026-03-04T11:22:33Z")).toBe("2026-03-04");
    expect(normalizeDate("2026-03-04")).toBe("2026-03-04");
  });

  /**
   * A malformed date must not travel as though it were a fact: the frontend
   * silently drops what it cannot parse, so the guard belongs upstream.
   */
  test("answers null on anything unparseable", () => {
    for (const raw of ["", "soon", null, undefined]) {
      expect(normalizeDate(raw)).toBeNull();
    }
  });
});

describe("applyPublishedBefore", () => {
  const hits = [
    { publishedDate: "2026-01-01" },
    { publishedDate: "2026-06-01" },
    { publishedDate: null },
  ];

  test("keeps only hits published on or before the bound", () => {
    expect(applyPublishedBefore(hits, "2026-03-01")).toEqual([
      { publishedDate: "2026-01-01" },
      { publishedDate: null },
    ]);
  });

  /**
   * Undated hits are KEPT on purpose. Most of the web does not stamp a
   * publication date, so dropping them would silently empty the result set
   * every time the model bounded a search from above.
   */
  test("keeps undated hits", () => {
    expect(
      applyPublishedBefore([{ publishedDate: null }], "1999-01-01"),
    ).toHaveLength(1);
  });

  test("is a no-op without a bound", () => {
    expect(applyPublishedBefore(hits, undefined)).toEqual(hits);
  });
});

describe("recencyToAfterDate", () => {
  test("collapses a relative window onto a date bound", () => {
    const now = new Date("2026-09-12T00:00:00Z");
    expect(recencyToAfterDate("week", now)).toBe("2026-09-05");
    expect(recencyToAfterDate("month", now)).toBe("2026-08-12");
  });

  test("is undefined when no window was asked for", () => {
    expect(recencyToAfterDate(undefined)).toBeUndefined();
  });
});

describe("matchesSelectPaths", () => {
  test("matches the path, not the whole URL", () => {
    expect(matchesSelectPaths("https://x.com/docs/a", ["^/docs/"])).toBe(true);
    expect(matchesSelectPaths("https://docs.x.com/api", ["^/docs/"])).toBe(
      false,
    );
  });

  test("keeps everything when no filter was given", () => {
    expect(matchesSelectPaths("https://x.com/a", undefined)).toBe(true);
    expect(matchesSelectPaths("https://x.com/a", [])).toBe(true);
  });

  /**
   * A pattern the model got wrong must not silently empty the map — the
   * failure mode would look like "this site has no pages".
   */
  test("an unparseable pattern drops nothing", () => {
    expect(matchesSelectPaths("https://x.com/a", ["([unclosed"])).toBe(true);
  });
});
