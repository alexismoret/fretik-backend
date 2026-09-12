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

const LOC = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
const SITEMAP_DIRECTIVE = /^\s*sitemap\s*:\s*(\S+)/gim;

/** Minimal XML entity decoding — `<loc>` values are escaped per the spec. */
const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const locations = (xml: string): string[] => {
  const found: string[] = [];
  for (const match of xml.matchAll(LOC)) {
    const raw = match[1];
    if (raw !== undefined && raw.length > 0) found.push(unescapeXml(raw));
  }
  return found;
};

/** A `<sitemapindex>` points at more sitemaps; a `<urlset>` at pages. */
const isIndex = (xml: string): boolean => /<sitemapindex[\s>]/i.test(xml);

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

      const found = locations(xml);
      if (isIndex(xml)) next.push(...found);
      else urls.push(...found);
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
