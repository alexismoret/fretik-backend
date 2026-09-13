import { previewUserAgent, timeouts } from "./config";
import { safeFetch } from "./http";

/**
 * Link-preview metadata, read from the `<head>` of a page we already cite.
 *
 * **Why this exists at all.** No search API built for agents returns images —
 * they return text — and measured 2026-09-12, neither does the fetch backend:
 * Parallel's `/v1/extract` produces Markdown with every `![](…)` stripped (the
 * Wikipedia article on MacBook Pro came back with 281 links and ZERO images),
 * so the previous design, which harvested pictures out of that Markdown, could
 * never return one. It spent ~25 s and three extract calls per search doing it.
 * Perplexity has no image route either since `return_images` retired with the
 * Sonar chat endpoint. The remaining source of a page's picture is the page's
 * own `og:image`, which is the tag every social network reads for exactly this
 * purpose, and reading it is a `<head>`-sized GET.
 *
 * **What it costs.** Nothing to a vendor, ~150-400 ms for a batch fetched in
 * parallel. It is the one read that leaves our own IP, which is why it is
 * strictly best-effort: a 403 from a bot-protected origin (measured on 3 of 20
 * sites — all Cloudflare) costs the cover image and nothing else. Title,
 * description and favicon already come from the search result, so a card still
 * renders for a site that refuses us.
 */
export interface PageMetadata {
  /** The URL as requested — the key callers join on. */
  url: string;
  title: string | null;
  description: string | null;
  /** Absolute http(s) URL of the page's own cover image. */
  image: string | null;
  /**
   * The publisher, e.g. "MacGeneration" — `og:site_name` when the page
   * declares a real name, its bare host otherwise. Never null: a card always
   * has something to attribute the link to.
   */
  siteName: string;
}

/**
 * Hard ceiling per page. The read normally stops much earlier — at `</head>`,
 * which is where every `og:` tag lives — so this only binds for a page with no
 * head terminator at all, hostile or broken. Measured over eight real pages:
 * 884 KB for the batch stopping at the head, against 2 322 KB to this cap.
 */
const MAX_BYTES = 262_144;

/** Concurrent preview reads. Batches are small (≤ 8) and the origins differ. */
const CONCURRENCY = 8;

/**
 * A whole `<meta>` tag, then its attributes — two passes rather than one
 * pattern matching key and value together.
 *
 * The naive single pattern reads `content\s*=\s*["']([^"']*)["']`, which stops
 * at the FIRST quote of either kind and so truncates any double-quoted value
 * containing an apostrophe. That is not an edge case in French:
 * `content="MacBook M5 : jusqu'à 300 €"` came back as `MacBook M5 : jusqu`.
 * Matching the tag first, then each attribute against its own quote character,
 * removes the whole class.
 *
 * Regex rather than an HTML parser because the input is untrusted, arbitrarily
 * malformed markup we want four known keys out of: a regex that misses a tag
 * yields no card, while a parser that chokes throws on a path that must not.
 */
const META_TAG = /<meta\b(?:"[^"]*"|'[^']*'|[^>])*>/gi;
const META_ATTR =
  /\b(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

const TITLE_TAG = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i;
const HEAD_END = /<\/head\s*>/i;
const CHARSET_META = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i;
const CHARSET_HEADER = /charset\s*=\s*["']?\s*([\w-]+)/i;

/** The handful of entities that actually appear in `og:` values. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * A numeric entity, or the text itself when it names no character.
 *
 * `String.fromCodePoint` THROWS above `0x10FFFF`, and one `&#9999999999;`
 * anywhere in a `<head>` would otherwise cost that page its whole preview —
 * the parse runs inside a single try/catch. Out-of-range stays literal, which
 * is what a browser does with it too.
 */
const fromCodePoint = (whole: string, code: number): string =>
  Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;

const decodeEntities = (raw: string): string =>
  raw
    .replace(/&#(\d+);/g, (whole, code: string) =>
      fromCodePoint(whole, Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (whole, code: string) =>
      fromCodePoint(whole, Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (whole, name: string) => {
      const found = ENTITIES[name.toLowerCase()];
      return found ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();

/**
 * Legacy encodings a page may declare, and the alias each is written under.
 *
 * An allowlist rather than passing the sniffed label straight to
 * `TextDecoder`: the label comes off an untrusted page, and the constructor is
 * typed against a closed set. Everything absent here decodes as UTF-8, which is
 * what a bare `TextDecoder()` would have done anyway.
 */
const ENCODINGS = new Map<string, "latin1" | "windows-1252" | "iso-8859-15">([
  ["iso-8859-1", "latin1"],
  ["iso8859-1", "latin1"],
  ["latin1", "latin1"],
  ["windows-1252", "windows-1252"],
  ["cp1252", "windows-1252"],
  ["iso-8859-15", "iso-8859-15"],
]);

/**
 * Decode the body as the page declares itself, not as we wish it were.
 *
 * A French retail page served `charset=iso-8859-1` decoded as UTF-8 puts
 * "Noir sidÃ©ral" in a card title — garbage the reader sees, so it is worth
 * the few lines.
 */
const decodeHtml = (
  body: Uint8Array<ArrayBuffer>,
  contentType: string | null,
): string => {
  const label =
    contentType?.match(CHARSET_HEADER)?.[1] ??
    new TextDecoder().decode(body.subarray(0, 2048)).match(CHARSET_META)?.[1];

  const encoding =
    label === undefined ? undefined : ENCODINGS.get(label.toLowerCase());

  if (encoding === undefined) return new TextDecoder().decode(body);
  try {
    return new TextDecoder(encoding).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
};

/**
 * Absolute http(s) URL, or `null`.
 *
 * Two jobs in one place. Relative `og:image` values are legal and common, so
 * they are resolved against the page they came from. And the result is a URL
 * an `<img src>` will load in the user's browser, from a document written by a
 * model that reads attacker-controlled web pages — so `javascript:` and
 * `data:` are refused here, at the boundary, rather than trusted to the
 * renderer.
 */
const absoluteHttpUrl = (value: string, base: string): string | null => {
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
};

const readTags = (html: string): Map<string, string> => {
  const head = html.split(HEAD_END)[0] ?? html;
  const tags = new Map<string, string>();

  for (const tag of head.match(META_TAG) ?? []) {
    let key: string | undefined;
    let value: string | undefined;

    for (const attr of tag.matchAll(META_ATTR)) {
      const read = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (attr[1]?.toLowerCase() === "content") value = read;
      else key ??= read.toLowerCase();
    }

    // First wins: `og:image` appears several times on sites that offer several
    // crops, and the first is the one they lead with.
    if (
      key !== undefined &&
      key !== "" &&
      value !== undefined &&
      value !== ""
    ) {
      if (!tags.has(key)) tags.set(key, decodeEntities(value));
    }
  }
  return tags;
};

/**
 * The publisher's name, or the bare host when the page only echoes its domain.
 *
 * Measured: `materiel.net` declares no `og:site_name` at all and boulanger.com
 * declares `www.boulanger.com`. Both should read "materiel.net" /
 * "boulanger.com" on a card — a leading `www.` is noise nobody writes.
 */
const publisherName = (declared: string | null, host: string): string => {
  const bare = host.replace(/^www\./i, "");
  if (declared === null) return bare;
  const normalised = declared
    .trim()
    .toLowerCase()
    .replace(/^www\./i, "");
  return normalised === bare ? bare : declared.trim();
};

/**
 * Read card metadata out of a page's markup. Exported for its tests: this is
 * where every real-world quirk lands (attribute order, entities, relative
 * image paths, a `javascript:` value written by a poisoned page), and it is
 * pure, so it is tested directly rather than behind a network double.
 */
export const parsePageMetadata = (
  requestedUrl: string,
  finalUrl: string,
  html: string,
): PageMetadata => {
  const tags = readTags(html);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = tags.get(key);
      if (value !== undefined && value !== "") return value;
    }
    return null;
  };

  const rawImage = pick(
    "og:image",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  );
  const titleTag = html.match(TITLE_TAG)?.[1];

  return {
    url: requestedUrl,
    title:
      pick("og:title", "twitter:title") ??
      (titleTag === undefined ? null : decodeEntities(titleTag) || null),
    description: pick("og:description", "twitter:description", "description"),
    image: rawImage === null ? null : absoluteHttpUrl(rawImage, finalUrl),
    siteName: publisherName(
      pick("og:site_name", "application-name"),
      hostOf(finalUrl) ?? hostOf(requestedUrl) ?? "",
    ),
  };
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Read one page's preview metadata. Resolves to `null` on ANY failure —
 * blocked, unreachable, not HTML, malformed. Never throws: this runs beside an
 * answer that is already correct without it.
 */
export const readPageMetadata = async (
  url: string,
  timeoutMs: number = timeouts().preview,
): Promise<PageMetadata | null> => {
  try {
    const result = await safeFetch(url, {
      timeoutMs,
      maxBytes: MAX_BYTES,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      userAgent: previewUserAgent(),
      // Everything we want is in the `<head>`; the rest is someone else's
      // bandwidth. Measured: 884 KB instead of 2 322 KB over eight pages.
      stopAtHead: true,
    });

    const contentType = result.contentType ?? "";
    if (contentType !== "" && !/html|xml/i.test(contentType)) return null;

    const html = decodeHtml(result.body, result.contentType);
    return parsePageMetadata(url, result.finalUrl, html);
  } catch {
    return null;
  }
};

/**
 * Read a batch of pages, keyed by the URL as requested.
 *
 * URLs that failed are simply absent from the map — callers merge what they
 * got onto results they already hold, so "no metadata" and "no entry" are the
 * same thing and there is no failure list to interpret.
 */
export const readPageMetadataBatch = async (
  urls: readonly string[],
  timeoutMs: number = timeouts().preview,
): Promise<Map<string, PageMetadata>> => {
  const out = new Map<string, PageMetadata>();
  const unique = [...new Set(urls)];

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(
      slice.map((url) => readPageMetadata(url, timeoutMs)),
    );
    for (const meta of batch) {
      if (meta !== null) out.set(meta.url, meta);
    }
  }

  return out;
};
