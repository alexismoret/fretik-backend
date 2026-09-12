import { hostFromUrl } from "../web-egress";
import { faviconService } from "./config";
import type { WebImage } from "./types";

/**
 * Shared normalisation applied to every provider's output, so a hit looks the
 * same to the model and to the UI whoever produced it.
 */

/**
 * Favicon URL for a result, derived from its host.
 *
 * Search APIs built for agents return text, not chrome: neither Perplexity nor
 * Parallel carries a favicon field. Deriving it keeps the `favicon` key on the
 * output contract the frontend already renders — no component change, no broken
 * history — and is in practice more reliable than the Tavily field it replaces,
 * which was often `null`. Returns `null` when the operator emptied
 * `AI_WEB_FAVICON_SERVICE` or the URL has no parseable host; the UI then shows
 * its globe icon.
 */
export const faviconFor = (url: string): string | null => {
  const template = faviconService();
  if (template === null) return null;
  const host = hostFromUrl(url);
  if (host === null) return null;
  return template.replace("{host}", host);
};

/**
 * Join a provider's ranked passages into the single `content` string the
 * contract carries.
 *
 * The elision marker earns its place twice: it tells the MODEL the passages are
 * discontinuous — without it two unrelated sentences read as one quotation and
 * get cited as contiguous source text — and it gives the UI's `line-clamp-2` a
 * clean first line. `[...]` is the marker Tavily used for chunked extracts, so
 * stored conversations and new ones read alike.
 */
export const joinExcerpts = (excerpts: readonly string[]): string =>
  excerpts
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .join("\n\n[...]\n\n");

/**
 * Normalise a provider's publication date to `YYYY-MM-DD`, or `null`.
 *
 * Providers disagree: Perplexity emits a plain date, Parallel the same, a
 * scraper whatever the page's meta tag held. The frontend feeds this to
 * `new Date()` and drops anything unparseable, so the guard belongs here — a
 * malformed date must not travel as though it were a fact.
 */
export const normalizeDate = (
  raw: string | null | undefined,
): string | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

/**
 * Drop hits published after `publishedBefore`.
 *
 * Perplexity bounds a search on both sides natively, so this only runs for a
 * provider whose source policy bounds it from below (Parallel's `after_date`).
 * An UNDATED hit is kept: dropping everything a source did not stamp would
 * silently empty most result sets.
 */
export const applyPublishedBefore = <
  T extends { publishedDate: string | null },
>(
  hits: readonly T[],
  publishedBefore: string | undefined,
): T[] => {
  if (publishedBefore === undefined) return [...hits];
  return hits.filter(
    (h) => h.publishedDate === null || h.publishedDate <= publishedBefore,
  );
};

/** `recency` as an ISO date bound, for providers that take dates only. */
export const recencyToAfterDate = (
  recency: "hour" | "day" | "week" | "month" | "year" | undefined,
  now: Date = new Date(),
): string | undefined => {
  if (recency === undefined) return undefined;
  const days = { hour: 1, day: 1, week: 7, month: 31, year: 366 }[recency];
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
};

/**
 * Keep only URLs whose PATH matches one of the regexes.
 *
 * `webMap`'s path filter used to be served by the provider (Tavily's
 * `select_paths`); sitemap discovery has no such notion, so it runs here. Free,
 * and strictly more predictable than a server-side matcher: the pattern is
 * anchored nowhere, matching the old semantics. An unparseable pattern drops
 * nothing rather than failing the call.
 */
export const matchesSelectPaths = (
  url: string,
  selectPaths: readonly string[] | undefined,
): boolean => {
  if (selectPaths === undefined || selectPaths.length === 0) return true;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return selectPaths.some((pattern) => {
    try {
      return new RegExp(pattern).test(path);
    } catch {
      return true;
    }
  });
};

/** Markdown image syntax: `![alt](url "optional title")`. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)[^)]*\)/g;

/**
 * Page furniture that is never worth showing a user: the site's own logo, the
 * author's avatar, a sprite, a tracking pixel. Matched on the path because
 * Markdown carries no dimensions to filter on.
 */
const IMAGE_NOISE =
  /(^|\/)(logo|logos|icons?|favicons?|avatars?|sprites?|badges?|buttons?|pixel|spacer|placeholder|thumb(?:nail)?s?-?\d{0,3}x\d{0,3})[-._/]|\/(1x1|blank)\./i;

/** Extensions that are chrome or vector art rather than photography. */
const IMAGE_SKIP_EXT = /\.(svg|gif|ico|webmanifest)(\?|#|$)/i;

/**
 * Pull displayable images out of a page's Markdown.
 *
 * This is how the image strip survives the move off Tavily. Neither Perplexity
 * nor Parallel returns images, but Parallel's extract returns MARKDOWN, and
 * Markdown carries its `![alt](url)` — so the images of a page we are already
 * paying to read come free, with their alt text as the caption. That is the
 * same `{ url, description }` shape the gallery already renders.
 *
 * The honest trade against a dedicated image search: these are the images the
 * page chose, so provenance is better (every image belongs to a source the
 * agent can cite) but the set is noisier. Hence the filtering — and a page
 * whose only illustration sits in an `og:image` meta tag, outside the body,
 * contributes nothing.
 */
export const imagesFromMarkdown = (
  markdown: string,
  limit: number,
): WebImage[] => {
  const seen = new Set<string>();
  const images: WebImage[] = [];

  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) {
    if (images.length >= limit) break;

    const alt = (match[1] ?? "").trim();
    let url = (match[2] ?? "").trim();
    // Markdown allows the destination to be wrapped in angle brackets.
    if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);

    // Data URIs would be inlined into the tool result and blow the context
    // budget for a thumbnail; only an addressable image is worth returning.
    if (!/^https?:\/\//i.test(url)) continue;
    if (IMAGE_SKIP_EXT.test(url) || IMAGE_NOISE.test(url)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    images.push(alt.length > 0 ? { url, description: alt } : { url });
  }

  return images;
};
