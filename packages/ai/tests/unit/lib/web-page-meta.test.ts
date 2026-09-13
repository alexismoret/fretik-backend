import { describe, expect, test } from "bun:test";
import { advanceHeadMatch, HEAD_MATCHED } from "../../../src/lib/web/http";
import { parsePageMetadata } from "../../../src/lib/web/page-meta";
import { toUsDate } from "../../../src/lib/web/perplexity";

/**
 * Link-preview metadata: the `<head>` parse behind `::link-cards` and the
 * `::gallery` image strip.
 *
 * Every case here comes from markup a real site serves. The parse runs on
 * untrusted, arbitrarily malformed HTML written by whoever we happened to
 * cite, so the bar is "never throws, never emits a URL a browser should not
 * load" rather than "handles valid documents".
 */

const page = (head: string): string =>
  `<!doctype html><html><head>${head}</head><body><p>body</p></body></html>`;

describe("parsePageMetadata", () => {
  test("reads the card fields a publisher declares", () => {
    const meta = parsePageMetadata(
      "https://www.macg.co/a",
      "https://www.macg.co/a",
      page(`
        <meta property="og:title" content="MacBook M5 : jusqu'à 300 €">
        <meta property="og:description" content="Les promotions de rentrée.">
        <meta property="og:image" content="https://cdn.mgig.fr/cover.jpg">
        <meta property="og:site_name" content="MacGeneration">
      `),
    );

    expect(meta.title).toBe("MacBook M5 : jusqu'à 300 €");
    expect(meta.description).toBe("Les promotions de rentrée.");
    expect(meta.image).toBe("https://cdn.mgig.fr/cover.jpg");
    expect(meta.siteName).toBe("MacGeneration");
  });

  /**
   * `String.fromCodePoint` THROWS above `0x10FFFF`, and the whole parse runs
   * inside one try/catch — so a single malformed entity anywhere in the head
   * used to cost the page its title, description, cover AND publisher.
   */
  test("survives a numeric entity that names no character", () => {
    const meta = parsePageMetadata(
      "https://a.test/x",
      "https://a.test/x",
      page(`
        <meta property="og:title" content="Bad &#9999999999; entity">
        <meta property="og:image" content="https://a.test/cover.jpg">
        <meta property="og:site_name" content="A Test">
      `),
    );

    expect(meta.title).toBe("Bad &#9999999999; entity");
    expect(meta.image).toBe("https://a.test/cover.jpg");
    expect(meta.siteName).toBe("A Test");
  });

  test("still decodes entities that do name a character", () => {
    const meta = parsePageMetadata(
      "https://a.test/x",
      "https://a.test/x",
      page(`<meta property="og:title" content="caf&#233; &amp; th&#xe9;">`),
    );

    expect(meta.title).toBe("café & thé");
  });

  /** `content` before `property` is legal and shipped by real sites. */
  test("reads a meta tag in either attribute order", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`<meta content="https://x.test/c.jpg" property="og:image">`),
    );
    expect(meta.image).toBe("https://x.test/c.jpg");
  });

  test("falls back to twitter tags, then to <title>", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`
        <title>Plain title</title>
        <meta name="twitter:image" content="https://x.test/t.png">
      `),
    );
    expect(meta.title).toBe("Plain title");
    expect(meta.image).toBe("https://x.test/t.png");
  });

  /**
   * The chain below `twitter:` — `itemprop`, then `link rel="image_src"`, then
   * JSON-LD — in the order it is consulted. Each step exists because a real
   * site declares that one and nothing above it.
   */
  test("reads microdata, then image_src, then JSON-LD", () => {
    const itemprop = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`<meta itemprop="image" content="https://x.test/micro.jpg">`),
    );
    expect(itemprop.image).toBe("https://x.test/micro.jpg");

    const legacy = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`<link rel="image_src" href="https://x.test/legacy.jpg">`),
    );
    expect(legacy.image).toBe("https://x.test/legacy.jpg");

    /** Measured: evasionspascher.fr names its cover only here, relatively. */
    const structured = parsePageMetadata(
      "https://x.test/le-mag/article/",
      "https://x.test/le-mag/article/",
      page(`<script type="application/ld+json">
        {"@type":"Article","image":"images/cover.jpg"}
      </script>`),
    );
    expect(structured.image).toBe(
      "https://x.test/le-mag/article/images/cover.jpg",
    );
  });

  /**
   * `itemprop` names are bare words, so an un-namespaced key would collide with
   * the `<meta name>` of the same spelling — and "first tag wins" would hand
   * the collision to whichever the document declares first.
   */
  test("keeps an itemprop from colliding with a meta name", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`
        <meta name="image" content="not-a-url-the-card-should-take">
        <meta property="og:image" content="https://x.test/real.jpg">
      `),
    );
    expect(meta.image).toBe("https://x.test/real.jpg");
  });

  /**
   * One JSON-LD block routinely describes the publisher as well as the page,
   * and the `Organization` node — carrying the LOGO — is conventionally
   * declared first. A walk that took the first `image` it met would return it.
   */
  test("prefers the content node's image over the publisher's logo", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`<script type="application/ld+json">
        {"@graph":[
          {"@type":"Organization","image":"https://x.test/logo.png"},
          {"@type":"NewsArticle","image":{"url":"https://x.test/photo.jpg"}}
        ]}
      </script>`),
    );
    expect(meta.image).toBe("https://x.test/photo.jpg");
  });

  /** Malformed JSON-LD is ordinary. It must cost that block and nothing else. */
  test("survives a JSON-LD block that is not JSON", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`
        <script type="application/ld+json">{ this is not json }</script>
        <script type="application/ld+json">{"@type":"WebPage","image":"https://x.test/ok.jpg"}</script>
        <meta property="og:site_name" content="X Test">
      `),
    );
    expect(meta.image).toBe("https://x.test/ok.jpg");
    expect(meta.siteName).toBe("X Test");
  });

  /**
   * The chain stops short of the icon family on purpose: those ARE the favicon,
   * and the card already has a favicon band for a page that declares no
   * picture. Promoting one would make "no image" look like an image.
   */
  test("never promotes an icon to a cover", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`
        <link rel="apple-touch-icon" href="https://x.test/icon-180.png">
        <link rel="icon" href="https://x.test/favicon.ico">
      `),
    );
    expect(meta.image).toBeNull();
  });

  test("resolves a relative image against the page it came from", () => {
    const meta = parsePageMetadata(
      "https://shop.test/p/1",
      "https://shop.test/p/1",
      page(`<meta property="og:image" content="/media/cover.jpg">`),
    );
    expect(meta.image).toBe("https://shop.test/media/cover.jpg");
  });

  /**
   * The markup is written by a model that reads attacker-controlled pages, and
   * comark's sanitiser only URL-checks `href`/`src` — so a non-http scheme has
   * to die here, at the boundary, not in the renderer.
   */
  test("refuses an image URL a browser must not load", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox",
    ]) {
      const meta = parsePageMetadata(
        "https://x.test/a",
        "https://x.test/a",
        page(`<meta property="og:image" content="${hostile}">`),
      );
      expect(meta.image).toBeNull();
    }
  });

  test("decodes the entities og values actually carry", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`<meta property="og:title" content="MacBook Pro 14&#34; &amp; M5">`),
    );
    expect(meta.title).toBe('MacBook Pro 14" & M5');
  });

  /**
   * Measured on real sites: materiel.net declares no `og:site_name` and
   * boulanger.com declares `www.boulanger.com`. Both must read as the bare
   * domain on a card.
   */
  test("falls back to the bare host for the publisher name", () => {
    const none = parsePageMetadata(
      "https://www.materiel.net/produit/1",
      "https://www.materiel.net/produit/1",
      page(`<meta property="og:title" content="Un produit">`),
    );
    expect(none.siteName).toBe("materiel.net");

    const echoed = parsePageMetadata(
      "https://www.boulanger.com/ref/1",
      "https://www.boulanger.com/ref/1",
      page(`<meta property="og:site_name" content="www.boulanger.com">`),
    );
    expect(echoed.siteName).toBe("boulanger.com");
  });

  /** A body image is not a card image — only the `<head>` is authoritative. */
  test("ignores meta tags outside the head", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      `<html><head><title>T</title></head><body>
         <meta property="og:image" content="https://x.test/body.jpg">
       </body></html>`,
    );
    expect(meta.image).toBeNull();
  });

  test("returns nulls rather than throwing on junk", () => {
    const meta = parsePageMetadata("https://x.test/a", "https://x.test/a", "<");
    expect(meta.title).toBeNull();
    expect(meta.image).toBeNull();
    expect(meta.siteName).toBe("x.test");
  });

  /** First wins: sites list several crops and lead with the one they want. */
  test("keeps the first image when several are declared", () => {
    const meta = parsePageMetadata(
      "https://x.test/a",
      "https://x.test/a",
      page(`
        <meta property="og:image" content="https://x.test/1.jpg">
        <meta property="og:image" content="https://x.test/2.jpg">
      `),
    );
    expect(meta.image).toBe("https://x.test/1.jpg");
  });
});

/**
 * The early stop that makes always-on previews cheap: reading to `</head>`
 * instead of to the byte cap pulled 884 KB instead of 2 322 KB over eight real
 * pages. Its one failure mode is silent — miss the marker and you simply read
 * the whole body — so the split cases are pinned here.
 */
describe("advanceHeadMatch", () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const DONE = HEAD_MATCHED;

  test("finds the marker inside one chunk", () => {
    expect(advanceHeadMatch(bytes("<title>x</title></head><body>"), 0)).toBe(
      DONE,
    );
  });

  test("tolerates whitespace before the closing bracket", () => {
    expect(advanceHeadMatch(bytes("</head  >"), 0)).toBe(DONE);
    expect(advanceHeadMatch(bytes("</head\n>"), 0)).toBe(DONE);
  });

  /** The case a per-chunk search would miss: a TCP segment splitting it. */
  test("carries a match split across chunks, at every split point", () => {
    const marker = "</head>";
    for (let cut = 1; cut < marker.length; cut += 1) {
      let state = advanceHeadMatch(
        bytes(`<html><head>${marker.slice(0, cut)}`),
        0,
      );
      state = advanceHeadMatch(bytes(marker.slice(cut)), state);
      expect(state).toBe(DONE);
    }
  });

  test("matches whatever case the document uses", () => {
    expect(advanceHeadMatch(bytes("</HEAD>"), 0)).toBe(DONE);
    expect(advanceHeadMatch(bytes("</Head>"), 0)).toBe(DONE);
  });

  /**
   * A false positive truncates the head and loses every tag below it. The one
   * that matters is `</header>`, which contains `</head` — reachable inside a
   * JSON-LD script in the head, which is exactly where `og:` tags live.
   */
  test("does not stop on </header> or any other near miss", () => {
    expect(advanceHeadMatch(bytes("</header>"), 0)).not.toBe(DONE);
    expect(advanceHeadMatch(bytes("</heading>"), 0)).not.toBe(DONE);
    expect(advanceHeadMatch(bytes("<meta charset='utf-8'>"), 0)).toBe(0);
    expect(advanceHeadMatch(bytes("</hea<"), 0)).toBe(1);
  });

  /** A near miss must not eat the real tag that follows it. */
  test("still stops at the real tag after a near miss", () => {
    const html =
      '<script type="application/ld+json">"</header>"</script></head>';
    expect(advanceHeadMatch(bytes(html), 0)).toBe(DONE);
  });

  test("stays done once the marker has arrived", () => {
    const state = advanceHeadMatch(bytes("</head>"), 0);
    expect(advanceHeadMatch(bytes("<body>lots of page</body>"), state)).toBe(
      DONE,
    );
  });
});

/**
 * Perplexity's date filters reject ISO dates outright — measured
 * `search_after_date_filter '2026-09-01' must be in MM/DD/YYYY format`, HTTP
 * 400. Our whole surface speaks ISO, so this conversion is the only thing
 * standing between a date-bounded search and a failed call that silently
 * reroutes to the fallback provider.
 */
describe("toUsDate", () => {
  test("converts an ISO date to the format the filters demand", () => {
    expect(toUsDate("2026-09-01")).toBe("09/01/2026");
    expect(toUsDate("2024-12-31")).toBe("12/31/2024");
  });

  test("passes through anything that is not an ISO date", () => {
    expect(toUsDate("09/01/2026")).toBe("09/01/2026");
    expect(toUsDate("")).toBe("");
  });
});
