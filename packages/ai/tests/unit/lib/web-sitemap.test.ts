import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * Site discovery — the one web capability with no vendor behind it.
 *
 * `robots.txt` and `sitemap.xml` are published for robots to read, so the
 * crawl and the filtering both cost nothing where Tavily's `/map` billed per
 * discovered page and doubled that for semantic filtering. What has to be
 * proven here is that the walk stays BOUNDED and that the failure mode is
 * honest: a site with no sitemap must answer "nothing", never hang or invent.
 *
 * The HTTP seam is faked; `lib/web/http.ts`'s own guard rails (SSRF
 * re-validation per redirect hop, byte caps) are a separate concern from what
 * the walker does with the bytes.
 */

const served = new Map<string, string>();
const requested: string[] = [];

await mockModule("../../../src/lib/web/http", {
  safeFetch: async (url: string) => {
    requested.push(url);
    const body = served.get(url);
    if (body === undefined) throw new Error(`404 ${url}`);
    return {
      finalUrl: url,
      status: 200,
      contentType: "application/xml",
      body: new TextEncoder().encode(body),
    };
  },
  decodeBody: (result: { body: Uint8Array }) =>
    new TextDecoder().decode(result.body),
});

const { mapSiteFromSitemap, readSitemapDocument } =
  await import("../../../src/lib/web/sitemap");
type XmlParser = Pick<typeof Bun.XML, "parse"> | undefined;

/** The ambient parser, or `undefined` on a runtime without one. */
const ambientParser = (): XmlParser =>
  typeof (Bun as { XML?: { parse?: unknown } }).XML?.parse === "function"
    ? Bun.XML
    : undefined;

const urlset = (...urls: string[]): string =>
  `<?xml version="1.0"?><urlset>${urls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join("")}</urlset>`;

const sitemapindex = (...urls: string[]): string =>
  `<?xml version="1.0"?><sitemapindex>${urls
    .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

beforeEach(() => {
  served.clear();
  requested.length = 0;
});

describe("mapSiteFromSitemap", () => {
  test("reads the conventional sitemap when robots.txt is absent", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset("https://example.com/a", "https://example.com/b"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(requested[0]).toBe("https://example.com/robots.txt");
  });

  /**
   * `robots.txt` is where a site that keeps its sitemap somewhere unusual says
   * so, which is the only way to find it.
   */
  test("follows the Sitemap: directive advertised by robots.txt", async () => {
    served.set(
      "https://example.com/robots.txt",
      "User-agent: *\nDisallow:\nSitemap: https://example.com/custom/sm.xml\n",
    );
    served.set(
      "https://example.com/custom/sm.xml",
      urlset("https://example.com/found"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/found",
    ]);
  });

  test("descends a sitemap index into its children", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      sitemapindex(
        "https://example.com/sm-1.xml",
        "https://example.com/sm-2.xml",
      ),
    );
    served.set(
      "https://example.com/sm-1.xml",
      urlset("https://example.com/one"),
    );
    served.set(
      "https://example.com/sm-2.xml",
      urlset("https://example.com/two"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links.map((l) => l.url).sort()).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  test("decodes the XML entities a <loc> is escaped with", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset("https://example.com/a?x=1&amp;y=2"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links[0]?.url).toBe("https://example.com/a?x=1&y=2");
  });

  /**
   * "Map `https://example.com/docs`" almost always means "the pages under
   * /docs", and a sitemap lists the whole site — so scoping is applied for
   * free rather than making the model pass a redundant `select_paths`.
   */
  test("scopes to the requested path when the URL carries one", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset(
        "https://example.com/docs/intro",
        "https://example.com/docs/api",
        "https://example.com/blog/post",
      ),
    );

    const result = await mapSiteFromSitemap({
      url: "https://example.com/docs",
    });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/docs/intro",
      "https://example.com/docs/api",
    ]);
  });

  test("exposes the path as the link's title", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset("https://example.com/docs/api%20v2"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links[0]?.title).toBe("/docs/api v2");
  });

  test("filters on `search` across the URL and its path", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset("https://example.com/pricing", "https://example.com/careers"),
    );

    const result = await mapSiteFromSitemap({
      url: "https://example.com",
      search: "PRICING",
    });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/pricing",
    ]);
  });

  test("applies select_paths as regexes on the path", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset("https://example.com/docs/a", "https://example.com/blog/b"),
    );

    const result = await mapSiteFromSitemap({
      url: "https://example.com",
      selectPaths: ["^/docs/"],
    });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/docs/a",
    ]);
  });

  test("honours the limit and dedupes", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      urlset(
        "https://example.com/a",
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ),
    );

    const result = await mapSiteFromSitemap({
      url: "https://example.com",
      limit: 2,
    });

    expect(result.links.map((l) => l.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  /**
   * The honest limit of a vendor-free map, and the reason the tool answers
   * with a `WEB_MAP_NO_SITEMAP` code that steers the model to a
   * domain-restricted search rather than to a corrected retry.
   */
  test("answers an empty list when the site publishes no sitemap", async () => {
    const result = await mapSiteFromSitemap({ url: "https://example.com" });
    expect(result.links).toEqual([]);
  });

  /**
   * A hostile or merely enthusiastic index must not turn one tool call into a
   * crawl: the walk is bounded on documents and on nesting depth.
   */
  test("stops descending past the nesting bound", async () => {
    served.set(
      "https://example.com/sitemap.xml",
      sitemapindex("https://example.com/l1.xml"),
    );
    served.set(
      "https://example.com/l1.xml",
      sitemapindex("https://example.com/l2.xml"),
    );
    served.set(
      "https://example.com/l2.xml",
      sitemapindex("https://example.com/l3.xml"),
    );
    served.set(
      "https://example.com/l3.xml",
      urlset("https://example.com/too-deep"),
    );

    const result = await mapSiteFromSitemap({ url: "https://example.com" });

    expect(result.links).toEqual([]);
    expect(requested).not.toContain("https://example.com/l3.xml");
  });
});

/**
 * The XML shapes a naive `<loc>` scan gets wrong, run against BOTH reader
 * paths.
 *
 * Both have to stay correct, and which one a given run exercises depends on the
 * `bun` binary that happens to be installed — `Bun.XML` landed in 1.4, CI runs
 * `latest` and the Dockerfiles float on `oven/bun:1`. A suite that silently
 * tested whichever path the local runtime offers would be worse than none, so
 * the parser is passed in explicitly: `undefined` is the scan, `bunXml()` is
 * the parser, and the case table is shared.
 */
describe("reading a sitemap document", () => {
  const urlsetXml = (body: string): string =>
    `<?xml version="1.0"?><urlset>${body}</urlset>`;

  const CASES: Array<{ name: string; xml: string; expected: string[] }> = [
    {
      name: "plain urlset",
      xml: urlsetXml(
        "<url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url>",
      ),
      expected: ["https://example.com/a", "https://example.com/b"],
    },
    {
      // A one-page sitemap is where an XML-to-JSON reader silently returns
      // nothing: the single child comes back as an object, not an array.
      name: "a single url",
      xml: urlsetXml("<url><loc>https://example.com/only</loc></url>"),
      expected: ["https://example.com/only"],
    },
    {
      name: "a CDATA-wrapped loc",
      xml: urlsetXml(
        "<url><loc><![CDATA[https://example.com/cdata]]></loc></url>",
      ),
      expected: ["https://example.com/cdata"],
    },
    {
      // A commented-out entry is a page the site WITHDREW.
      name: "a commented-out loc",
      xml: urlsetXml(
        "<!-- <url><loc>https://example.com/retired</loc></url> --><url><loc>https://example.com/live</loc></url>",
      ),
      expected: ["https://example.com/live"],
    },
    {
      name: "a namespace-prefixed document",
      xml: '<?xml version="1.0"?><sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/prefixed</sm:loc></sm:url></sm:urlset>',
      expected: ["https://example.com/prefixed"],
    },
    {
      // Image sitemaps nest an `<image:loc>` in every `<url>`. Those are
      // assets: surfacing one hands the model a JPEG to `webFetch`.
      name: "an image sitemap",
      xml: '<?xml version="1.0"?><urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://example.com/page</loc><image:image><image:loc>https://cdn.example.com/photo.jpg</image:loc></image:image></url></urlset>',
      expected: ["https://example.com/page"],
    },
    {
      name: "escaped entities in a query string",
      xml: urlsetXml("<url><loc>https://example.com/a?x=1&amp;y=2</loc></url>"),
      expected: ["https://example.com/a?x=1&y=2"],
    },
    {
      name: "surrounding whitespace",
      xml: urlsetXml("<url><loc>\n  https://example.com/spaced\n </loc></url>"),
      expected: ["https://example.com/spaced"],
    },
    {
      name: "sibling metadata alongside the loc",
      xml: urlsetXml(
        "<url><loc>https://example.com/dated</loc><lastmod>2026-01-01</lastmod><priority>0.8</priority></url>",
      ),
      expected: ["https://example.com/dated"],
    },
  ];

  const paths: Array<{ label: string; parser: XmlParser }> = [
    { label: "scan", parser: undefined },
    ...(ambientParser() === undefined
      ? []
      : [{ label: "Bun.XML", parser: ambientParser() }]),
  ];

  for (const { label, parser } of paths) {
    describe(label, () => {
      for (const { name, xml, expected } of CASES) {
        test(name, () => {
          expect(readSitemapDocument(xml, parser).locations).toEqual(expected);
        });
      }

      test("recognises an index and its children", () => {
        const document = readSitemapDocument(
          '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/sm-1.xml</loc></sitemap></sitemapindex>',
          parser,
        );
        expect(document.isIndex).toBe(true);
        expect(document.locations).toEqual(["https://example.com/sm-1.xml"]);
      });
    });
  }

  /**
   * Not a nicety: an unescaped `&` in a query string is endemic in real
   * sitemaps, and `Bun.XML` raises on it. Strictness there would cost every URL
   * in the file, so the scan has to catch what the parser drops — and this
   * holds whichever runtime runs it, because the parser throws on both.
   */
  test("falls back to the scan on XML the parser refuses", () => {
    const malformed = urlsetXml(
      "<url><loc>https://example.com/a?b=1&c=2</loc></url>",
    );

    // The premise, stated only where there is a parser to state it about: this
    // input is genuinely rejected rather than merely awkward.
    const parser = ambientParser();
    if (parser !== undefined) {
      expect(() => parser.parse(malformed)).toThrow();
    }

    // The outcome, asserted on every runtime.
    expect(readSitemapDocument(malformed).locations).toEqual([
      "https://example.com/a?b=1&c=2",
    ]);
  });

  test("falls back to the scan on an unclosed tag", () => {
    const malformed =
      '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></urlset>';
    expect(readSitemapDocument(malformed).locations).toEqual([
      "https://example.com/a",
    ]);
  });
});
