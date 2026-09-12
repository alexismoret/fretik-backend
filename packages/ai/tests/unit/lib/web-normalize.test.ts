import { afterEach, describe, expect, test } from "bun:test";
import {
  applyPublishedBefore,
  faviconFor,
  imagesFromPages,
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

describe("imagesFromPages", () => {
  const page = (
    url: string,
    markdown: string,
    title: string | null = null,
  ) => ({
    url,
    title,
    markdown,
  });

  const urlsOf = (
    harvest: Map<string, { url: string; description?: string }[]>,
    pageUrl: string,
  ): string[] => (harvest.get(pageUrl) ?? []).map((i) => i.url);

  /**
   * This is how the image strip survives the move off Tavily: neither search
   * provider returns images, but a fetched page comes back as Markdown and
   * Markdown carries its own `![alt](url)`.
   */
  test("pulls images out with their alt text as the caption", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          "intro ![A quay at dusk](https://cdn.test/quay.jpg) end",
        ),
      ],
      5,
    );
    expect(harvest.get("https://a.test/1")).toEqual([
      { url: "https://cdn.test/quay.jpg", description: "A quay at dusk" },
    ]);
  });

  test("accepts the angle-bracket destination form", () => {
    const harvest = imagesFromPages(
      [page("https://a.test/1", "![x](<https://cdn.test/a b.jpg>)")],
      5,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([
      "https://cdn.test/a b.jpg",
    ]);
  });

  /**
   * A data URI would be inlined into the tool result and spend the context
   * budget on a thumbnail; only an addressable image is worth returning.
   */
  test("rejects non-http destinations", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          "![x](data:image/png;base64,iVBORw0KGgo=) ![y](/relative/a.jpg)",
        ),
      ],
      5,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([]);
  });

  test("drops obviously-named furniture", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          [
            "![logo](https://cdn.test/logo/brand.png)",
            "![icon](https://cdn.test/icons/menu.png)",
            "![avatar](https://cdn.test/avatars/jo.png)",
            "![pixel](https://cdn.test/1x1.gif)",
            "![vector](https://cdn.test/chart.svg)",
            "![real](https://cdn.test/photo.jpg)",
          ].join("\n"),
        ),
      ],
      10,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([
      "https://cdn.test/photo.jpg",
    ]);
  });

  /**
   * The case a filename blocklist cannot win, and the reason the harvest looks
   * across the batch: a CDN that serves the site logo from a content-hashed
   * path says nothing about what the image IS. What gives it away is that it
   * appears on every page, while a real illustration appears on one.
   */
  test("drops a hashed-filename logo because every page carries it", () => {
    const chrome = "https://cdn.test/a1b2c3d4e5.png";
    const harvest = imagesFromPages(
      [
        page("https://a.test/1", `![](${chrome}) ![](https://cdn.test/f1.jpg)`),
        page("https://a.test/2", `![](${chrome}) ![](https://cdn.test/f2.jpg)`),
        page("https://a.test/3", `![](${chrome}) ![](https://cdn.test/f3.jpg)`),
      ],
      10,
    );

    expect(urlsOf(harvest, "https://a.test/1")).toEqual([
      "https://cdn.test/f1.jpg",
    ]);
    expect(urlsOf(harvest, "https://a.test/3")).toEqual([
      "https://cdn.test/f3.jpg",
    ]);
  });

  test("keeps an image carried by a minority of the batch", () => {
    const shared = "https://cdn.test/series-header.jpg";
    const harvest = imagesFromPages(
      [
        page("https://a.test/1", `![](${shared})`),
        page("https://a.test/2", "![](https://cdn.test/b.jpg)"),
        page("https://a.test/3", "![](https://cdn.test/c.jpg)"),
      ],
      10,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([shared]);
  });

  /**
   * The signal needs more than one page to exist, so a single-page fetch must
   * not suppress its own content for lack of a comparison.
   */
  test("never suppresses the only page's images", () => {
    const repeated = "https://cdn.test/hero.jpg";
    const harvest = imagesFromPages(
      [page("https://a.test/1", `![](${repeated}) later ![](${repeated})`)],
      10,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([repeated]);
  });

  /**
   * An empty alt is common and leaves a gallery tile captionless, which is the
   * visible half of the regression against Tavily's model-written captions.
   */
  test("falls back to the page title when the alt text is empty", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          "![](https://cdn.test/a.jpg)",
          "Port of Le Havre",
        ),
      ],
      5,
    );
    expect(harvest.get("https://a.test/1")).toEqual([
      { url: "https://cdn.test/a.jpg", description: "Port of Le Havre" },
    ]);
  });

  test("prefers a real alt text over the page title", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          "![Crane at berth 4](https://cdn.test/a.jpg)",
          "Port",
        ),
      ],
      5,
    );
    expect(harvest.get("https://a.test/1")?.[0]?.description).toBe(
      "Crane at berth 4",
    );
  });

  test("dedupes within a page and honours the per-page limit", () => {
    const harvest = imagesFromPages(
      [
        page(
          "https://a.test/1",
          [
            "![a](https://cdn.test/1.jpg)",
            "![b](https://cdn.test/1.jpg)",
            "![c](https://cdn.test/2.jpg)",
            "![d](https://cdn.test/3.jpg)",
          ].join("\n"),
        ),
      ],
      2,
    );
    expect(urlsOf(harvest, "https://a.test/1")).toEqual([
      "https://cdn.test/1.jpg",
      "https://cdn.test/2.jpg",
    ]);
  });

  test("returns an entry for every page, empty ones included", () => {
    const harvest = imagesFromPages(
      [
        page("https://a.test/1", "no images here"),
        page("https://a.test/2", "![x](https://cdn.test/a.jpg)"),
      ],
      5,
    );
    expect(harvest.get("https://a.test/1")).toEqual([]);
    expect(urlsOf(harvest, "https://a.test/2")).toHaveLength(1);
  });
});
