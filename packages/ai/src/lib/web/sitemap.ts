import { timeouts } from "./config";
import { decodeBody, safeFetch } from "./http";
import { matchesSelectPaths } from "./normalize";
import type { SiteLink, WebMapOutcome, WebMapRequest } from "./types";

/**
 * Site discovery from `robots.txt` and `sitemap.xml` — the backend for
 * `webMap`, and the one web capability with no vendor behind it.
 *
 * It is free because these two files exist to be read by robots: they are
 * static text served by the origin rather than by a bot-detection layer, so the
 * datacenter-IP problem that rules out fetching PAGES ourselves does not apply
 * to fetching a site's own index of itself. We identify ourselves honestly in
 * the User-Agent (see `config.mapUserAgent`) so an origin that wants to refuse
 * can.
 *
 * It replaces Tavily's `/map`, which billed ~1 credit per 10 discovered pages
 * and doubled that when you wanted semantic filtering. Here both the crawl and
 * the filtering cost nothing.
 *
 * The honest limit: a site with no sitemap returns nothing. That is not a
 * failure to hide — the tool says so, and points the model at a
 * domain-restricted `searchWeb`, which reaches pages a sitemap never lists.
 */

/** Sitemap documents fetched per call, across the index tree. */
const MAX_DOCUMENTS = 12;

/** Nesting depth for sitemap indexes pointing at other indexes. */
const MAX_DEPTH = 2;

/** URLs collected before discovery stops, whatever the caller's limit. */
const MAX_URLS = 5_000;

/**
 * Reading a sitemap: `Bun.XML` first, a tolerant scan when it refuses.
 *
 * The parser is the right tool and gets four things right that a pattern has to
 * earn one at a time — CDATA-wrapped values, commented-out `<loc>`s (a page the
 * site deliberately WITHDREW), entity decoding, and namespace prefixes. It also
 * separates a page's `<loc>` from the `<image:loc>` nested inside it
 * STRUCTURALLY, where a pattern can only guess from the namespace declaration;
 * handing an image sitemap's JPEGs to `webFetch` is exactly the failure that
 * guess produces.
 *
 * The scan stays for one reason, and it is not about runtime versions: **a
 * conforming parser throws on malformed XML, and sitemaps in the wild are
 * frequently malformed**. An unescaped `&` in a query string is endemic.
 * Measured on Bun 1.4.2, `…/a?b=1&c=2` raises "Expected ';' after the entity
 * name" and an unclosed tag raises too — either costs every URL in the file,
 * where a scan still returns all of them. Be liberal in what you accept.
 *
 * So: parse, and fall through to the scan when the document defeats the parser.
 * Both paths are pinned by the same case table.
 */

/** `<loc>`, with any namespace prefix captured so it can be vetted. */
const LOC = /<(?:([\w.-]+):)?loc>\s*([\s\S]*?)\s*<\/(?:[\w.-]+:)?loc>/gi;

/** The prefix this document bound to the sitemap protocol namespace, if any. */
const SITEMAP_NS_PREFIX =
  /xmlns:([\w.-]+)\s*=\s*["']https?:\/\/www\.sitemaps\.org\/schemas\/sitemap\//i;

const XML_COMMENT = /<!--[\s\S]*?-->/g;
const CDATA = /^<!\[CDATA\[([\s\S]*?)\]\]>$/;

const SITEMAP_DIRECTIVE = /^\s*sitemap\s*:\s*(\S+)/gim;

/** What one sitemap document turned out to be. */
export interface SitemapDocument {
  /** `<sitemapindex>` points at more sitemaps; `<urlset>` at pages. */
  isIndex: boolean;
  locations: string[];
}

/*
 * ── The parser path ──────────────────────────────────────────────────────
 */

/**
 * The XML reader, as a value so a test can choose the path it exercises —
 * `undefined` is the scan. Both have to stay correct, and a suite that silently
 * tested whichever one the ambient runtime offers would be worse than none.
 */
export type XmlParser = Pick<typeof Bun.XML, "parse">;

/** An element name without its namespace prefix: `sm:loc` → `loc`. */
const localName = (key: string): string => key.slice(key.lastIndexOf(":") + 1);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The first child whose LOCAL name matches, whatever prefix the document used.
 * Attributes (`@name`) are skipped: they are not elements.
 */
const child = (node: Record<string, unknown>, name: string): unknown => {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@")) continue;
    if (localName(key) === name) return value;
  }
  return undefined;
};

/**
 * A single child element comes back as an object and several as an array — the
 * classic XML-to-JSON hazard, and the one a caller forgets until a one-page
 * sitemap silently yields nothing.
 */
const asArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Text of an element, which carries attributes under `#text` when it has any. */
const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value["#text"] === "string") {
    return value["#text"];
  }
  return undefined;
};

const parseWithBunXml = (
  xml: string,
  parser: XmlParser | undefined,
): SitemapDocument | null => {
  if (parser === undefined) return null;

  let tree: unknown;
  try {
    tree = parser.parse(xml);
  } catch {
    // Malformed beyond what a conforming parser tolerates — the scan takes over.
    return null;
  }
  if (!isRecord(tree)) return null;

  for (const [rootKey, rootValue] of Object.entries(tree)) {
    const root = localName(rootKey);
    const isIndexDoc = root === "sitemapindex";
    if (!isIndexDoc && root !== "urlset") continue;
    if (!isRecord(rootValue)) continue;

    // `<url>` under a urlset, `<sitemap>` under an index. Reading `loc` one
    // level down — and only one — is what keeps `<image:loc>` out: it lives
    // deeper, nested inside `<image:image>`.
    const entries = asArray(child(rootValue, isIndexDoc ? "sitemap" : "url"));
    const locations: string[] = [];

    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const value = text(child(entry, "loc"))?.trim();
      if (value !== undefined && value.length > 0) locations.push(value);
    }

    return { isIndex: isIndexDoc, locations };
  }

  return null;
};

/*
 * ── The scan path ────────────────────────────────────────────────────────
 */

/**
 * Drop comments before anything else looks at the document. A commented-out
 * `<loc>` is a page the site deliberately withdrew.
 */
const stripComments = (xml: string): string => xml.replace(XML_COMMENT, "");

/**
 * Minimal XML entity decoding — `<loc>` values are escaped per the spec, and a
 * CDATA section carries its text verbatim instead.
 */
const unescapeXml = (value: string): string => {
  const cdata = value.match(CDATA);
  if (cdata !== null) return cdata[1] ?? "";
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
};

const scanForLocations = (xml: string): string[] => {
  const nsPrefix = xml.match(SITEMAP_NS_PREFIX)?.[1];
  const found: string[] = [];

  for (const match of xml.matchAll(LOC)) {
    // Without a tree, a prefixed `<loc>` counts only when the prefix is the one
    // bound to the sitemap namespace — the guess that keeps `<image:loc>` and
    // `<video:loc>`, which are assets rather than pages, out of the results.
    const prefix = match[1];
    if (prefix !== undefined && prefix !== nsPrefix) continue;

    const raw = match[2];
    if (raw === undefined || raw.length === 0) continue;

    const url = unescapeXml(raw);
    if (url.length > 0) found.push(url);
  }

  return found;
};

const scanDocument = (xml: string): SitemapDocument => {
  const stripped = stripComments(xml);
  return {
    isIndex: /<(?:[\w.-]+:)?sitemapindex[\s>]/i.test(stripped),
    locations: scanForLocations(stripped),
  };
};

/**
 * Read one sitemap document, whichever path the runtime and the XML allow.
 *
 * `parser` is an argument rather than a lookup so the caller — in practice a
 * test — can pin the path under examination. Passing `undefined` is not a
 * degraded mode: it is the scan, which every deployment still falls back to the
 * moment a sitemap is malformed.
 */
export const readSitemapDocument = (
  xml: string,
  parser: XmlParser | undefined = Bun.XML,
): SitemapDocument => parseWithBunXml(xml, parser) ?? scanDocument(xml);

const fetchText = async (
  url: string,
  timeoutMs: number,
): Promise<string | null> => {
  try {
    return decodeBody(await safeFetch(url, { timeoutMs }));
  } catch {
    // A missing or refused sitemap is the normal case for most of the web,
    // not an error worth surfacing: the caller tries the next candidate.
    return null;
  }
};

/**
 * Sitemap URLs advertised by `robots.txt`, which is where a site that keeps its
 * sitemap somewhere unusual says so. Falls back to the two conventional paths.
 */
const discoverSitemapUrls = async (
  origin: string,
  timeoutMs: number,
): Promise<string[]> => {
  const robots = await fetchText(
    new URL("/robots.txt", origin).toString(),
    timeoutMs,
  );

  const advertised: string[] = [];
  if (robots !== null) {
    for (const match of robots.matchAll(SITEMAP_DIRECTIVE)) {
      const raw = match[1];
      if (raw === undefined) continue;
      try {
        advertised.push(new URL(raw, origin).toString());
      } catch {
        // A malformed directive is the site's problem, not a reason to stop.
      }
    }
  }

  if (advertised.length > 0) return advertised.slice(0, MAX_DOCUMENTS);

  return [
    new URL("/sitemap.xml", origin).toString(),
    new URL("/sitemap_index.xml", origin).toString(),
  ];
};

/**
 * Walk the sitemap tree breadth-first, bounded on documents, depth and URLs, so
 * a site with a pathological index cannot turn one tool call into a crawl.
 */
const collectUrls = async (
  seeds: string[],
  timeoutMs: number,
): Promise<string[]> => {
  const urls: string[] = [];
  const visited = new Set<string>();
  let frontier = seeds;
  let documents = 0;

  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];

    for (const candidate of frontier) {
      if (documents >= MAX_DOCUMENTS || urls.length >= MAX_URLS) break;
      if (visited.has(candidate)) continue;
      visited.add(candidate);

      const xml = await fetchText(candidate, timeoutMs);
      if (xml === null) continue;
      documents += 1;

      const document = readSitemapDocument(xml);
      if (document.isIndex) next.push(...document.locations);
      else urls.push(...document.locations);
    }

    frontier = next;
  }

  return urls;
};

/**
 * The path a URL occupies on its site — the only label a sitemap offers, and a
 * legible one: `/docs/api/webhooks` tells the model what the page is about far
 * better than the bare URL does.
 */
const titleFromUrl = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    return pathname === "/" ? null : decodeURIComponent(pathname);
  } catch {
    return null;
  }
};

export const mapSiteFromSitemap = async (
  request: WebMapRequest,
): Promise<WebMapOutcome> => {
  const timeoutMs = timeouts().map;
  const limit = request.limit ?? 50;
  const origin = new URL(request.url).origin;

  const seeds = await discoverSitemapUrls(origin, timeoutMs);
  const discovered = await collectUrls(seeds, timeoutMs);

  // The caller asked about a section, not just a host: when the requested URL
  // carries a path, keep the URLs under it. Costs nothing and is almost always
  // what "map https://example.com/docs" means.
  const requestedPath = new URL(request.url).pathname;
  const scoped =
    requestedPath === "/"
      ? discovered
      : discovered.filter((u) => {
          try {
            return new URL(u).pathname.startsWith(requestedPath);
          } catch {
            return false;
          }
        });

  const needle = request.search?.trim().toLowerCase();
  const seen = new Set<string>();
  const links: SiteLink[] = [];

  for (const url of scoped) {
    if (links.length >= limit) break;
    if (seen.has(url)) continue;
    if (!matchesSelectPaths(url, request.selectPaths)) continue;

    const title = titleFromUrl(url);
    if (
      needle !== undefined &&
      needle.length > 0 &&
      !url.toLowerCase().includes(needle) &&
      !(title ?? "").toLowerCase().includes(needle)
    ) {
      continue;
    }

    seen.add(url);
    links.push({ url, title });
  }

  return { baseUrl: request.url, links };
};
