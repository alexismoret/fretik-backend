import {
  assertFetchableTarget,
  assertResolvedTargetAllowed,
} from "../web-egress";
import { mapUserAgent } from "./config";

/**
 * The one place this service fetches the open web itself.
 *
 * Everything an agent READS goes through a provider — `webFetch` runs on
 * Parallel's headless browser precisely so page retrieval happens on their
 * egress and not from our single datacenter address. Two narrow cases are
 * served here instead, and neither is a general fetch:
 *
 *  - **site discovery** — `robots.txt` and `sitemap.xml` are published FOR
 *    robots, served as static text by the origin rather than by a
 *    bot-detection layer, and cost nothing;
 *  - **link previews** — the `<head>` of a page we are already citing, for its
 *    `og:` card metadata (`page-meta.ts`). Measured 2026-09-12: Parallel's
 *    extract returns Markdown with every image stripped, so a preview image
 *    cannot come from the provider at any price. The read is head-sized,
 *    opt-in, and degrades to no image rather than failing the answer.
 *
 * Because it makes `web-egress.ts` load-bearing for the first time — until now
 * every fetch happened at a vendor, as that module's own comment admits — the
 * hardening is spelled out rather than assumed, and mirrors what OpenClaw's
 * local `web_fetch` does:
 *
 *  - the target is validated BEFORE the request (scheme, internal/private/
 *    loopback/link-local/metadata hosts, length, operator domain policy);
 *  - redirects are followed MANUALLY and every hop is re-validated, because a
 *    public URL redirecting to `169.254.169.254` is the whole SSRF game;
 *  - the body is read through a byte cap, so a hostile or broken origin cannot
 *    stream the process out of memory;
 *  - a deadline aborts the request rather than leaving a socket hanging.
 */

/** Redirect hops followed before giving up. Matches OpenClaw's default. */
const MAX_REDIRECTS = 3;

/** Hard ceiling on a downloaded body. Sitemaps are text; 5 MB is generous. */
const MAX_BYTES = 5_000_000;

export class WebHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebHttpError";
  }
}

export interface SafeFetchResult {
  /** Where the request finally landed, after redirects. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Raw `Content-Disposition`, when the origin named the file itself. */
  contentDisposition: string | null;
  /**
   * Explicitly backed by an `ArrayBuffer`, not the default `ArrayBufferLike`:
   * `Bun.gunzipSync` refuses a possibly-shared buffer, and the copy below
   * always allocates a plain one.
   */
  body: Uint8Array<ArrayBuffer>;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes?: number;
  /**
   * `Accept` for this call. Defaults to the text/XML set site discovery wants;
   * a preview read asks for HTML, and some origins content-negotiate on it.
   */
  accept?: string;
  /** Overrides `mapUserAgent()` — see `previewUserAgent()` for why. */
  userAgent?: string;
  /**
   * Stop reading as soon as the document's `</head>` has arrived. For a link
   * preview, everything after it is bandwidth nobody reads.
   */
  stopAtHead?: boolean;
  /**
   * What `maxBytes` means. The default truncates, which is right for a
   * document being read for its text — half a sitemap still answers the
   * question. It is wrong for a FILE: a truncated PDF is not a small PDF, it
   * is a corrupt one, and handing the agent a broken artifact to debug is
   * worse than telling it the file was too large. `reject` throws instead,
   * and refuses on `Content-Length` before reading a byte when it can.
   */
  overflow?: "truncate" | "reject";
}

/**
 * Fetch a public URL with the full guard rail. Throws `WebEgressError` when a
 * target — original or redirected — is not a legitimate public destination.
 */
export const safeFetch = async (
  url: string,
  {
    timeoutMs,
    maxBytes = MAX_BYTES,
    accept = "text/plain, application/xml, text/xml, */*;q=0.5",
    userAgent,
    stopAtHead = false,
    overflow = "truncate",
  }: SafeFetchOptions,
): Promise<SafeFetchResult> => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-validated on EVERY hop, not just the first — a redirect is the
      // cheapest way to turn a vetted URL into an unvetted one. The name is
      // checked as a string first (cheap, catches literal addresses and the
      // domain policy), then as what it actually RESOLVES to.
      assertFetchableTarget(current);
      await assertResolvedTargetAllowed(current);

      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent ?? mapUserAgent(),
          Accept: accept,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new WebHttpError(
            `Redirect without a Location header (${response.status})`,
            response.status,
          );
        }
        // Relative Locations are legal and common; resolve against the hop we
        // are on, then let the next iteration validate the result.
        current = new URL(location, current).toString();
        continue;
      }

      if (!response.ok) {
        throw new WebHttpError(
          `HTTP ${response.status} for ${current}`,
          response.status,
        );
      }

      // Refuse on the declared size before spending the transfer, when the
      // origin declares one. A missing or lying header is caught below.
      if (overflow === "reject") {
        const declared = Number.parseInt(
          response.headers.get("content-length") ?? "",
          10,
        );
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel();
          throw new WebHttpError(
            `Body is ${declared.toString()} bytes, over the ${maxBytes.toString()} byte limit`,
            413,
          );
        }
      }

      return {
        finalUrl: current,
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
        body: await readCapped(response, maxBytes, stopAtHead, overflow),
      };
    }

    throw new WebHttpError(`More than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(deadline);
  }
};

/**
 * `</head` as bytes, for the early stop below.
 *
 * Matched on bytes rather than decoded text because the charset is not known
 * until the document says so, and this literal is ASCII — identical in UTF-8,
 * latin-1 and every windows-125x page we might meet.
 */
const HEAD_CLOSE = [0x3c, 0x2f, 0x68, 0x65, 0x61, 0x64];

/** Seen `</head`, now looking for the `>` that closes it. */
const AWAITING_GT = HEAD_CLOSE.length;

/** The whole tag has arrived. */
export const HEAD_MATCHED = HEAD_CLOSE.length + 1;

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/** Lowercased, so the scan matches `</HEAD` and `</Head` too. */
const lower = (byte: number): number =>
  byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;

/**
 * Advance the `</head>` match over one chunk, returning the state to carry into
 * the next. `HEAD_MATCHED` means the whole tag has arrived.
 *
 * Carried ACROSS chunks rather than searched within each, because a seven-byte
 * literal is routinely split by a TCP segment and a per-chunk search would miss
 * it — silently, by reading the whole body instead of stopping.
 *
 * The closing `>` is part of the match, and that is not pedantry: `</head` is a
 * prefix of `</header>`, and a `<script type="application/ld+json">` inside the
 * head can carry markup. Stopping there would truncate the head and lose every
 * tag below it — which is the one way this optimisation could cost metadata
 * rather than bandwidth.
 */
export const advanceHeadMatch = (
  chunk: Uint8Array,
  matched: number,
): number => {
  let state = matched;
  for (const byte of chunk) {
    if (state === HEAD_MATCHED) return state;

    if (state === AWAITING_GT) {
      if (byte === 0x3e) state = HEAD_MATCHED;
      else if (isSpace(byte)) continue;
      else state = byte === HEAD_CLOSE[0] ? 1 : 0;
      continue;
    }

    if (lower(byte) === HEAD_CLOSE[state]) {
      state += 1;
    } else {
      // `<` can only ever restart the match, never continue it — true because
      // no proper prefix of `</head` is also one of its suffixes.
      state = byte === HEAD_CLOSE[0] ? 1 : 0;
    }
  }
  return state;
};

/**
 * Read a response body, stopping at `maxBytes` — or as soon as `stopAtHead`
 * has seen the end of the document's `<head>`.
 *
 * Streamed rather than `arrayBuffer()`d on purpose: `Content-Length` is a hint
 * a hostile origin controls, so the cap has to be enforced against the bytes
 * that actually arrive.
 *
 * The early stop is what makes always-on link previews cheap. Every `og:` tag
 * lives in the `<head>`, and reading past it is pure waste on someone else's
 * bandwidth as well as ours: measured over eight real pages, a batch pulled
 * **2 322 KB** to the byte cap and **884 KB** stopping at `</head>` — the same
 * metadata for 38 % of the traffic, and sooner.
 *
 * The match runs across chunk boundaries (a six-byte literal is easily split
 * by a TCP segment) with a state machine rather than a per-chunk search, which
 * `</head` allows because no proper prefix of it is also a suffix.
 */
const readCapped = async (
  response: Response,
  maxBytes: number,
  stopAtHead = false,
  overflow: "truncate" | "reject" = "truncate",
): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  let matched = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    chunks.push(value);
    total += value.byteLength;

    if (stopAtHead) {
      matched = advanceHeadMatch(value, matched);
      if (matched === HEAD_MATCHED) {
        await reader.cancel();
        break;
      }
    }

    if (total >= maxBytes) {
      await reader.cancel();
      if (overflow === "reject") {
        throw new WebHttpError(
          `Body exceeds the ${maxBytes.toString()} byte limit`,
          413,
        );
      }
      break;
    }
  }

  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.byteLength) break;
    const slice = chunk.subarray(0, out.byteLength - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
};

/**
 * Decode a fetched body to text, transparently gunzipping a `.gz` payload.
 *
 * `fetch` already decodes `Content-Encoding: gzip`, but a sitemap served as a
 * `.xml.gz` FILE arrives as gzip bytes with no such header — a distinction
 * that silently produces mojibake instead of an error if you ignore it.
 */
export const decodeBody = (result: SafeFetchResult): string => {
  const looksGzipped =
    result.body.length > 2 &&
    result.body[0] === 0x1f &&
    result.body[1] === 0x8b;

  const bytes = looksGzipped ? Bun.gunzipSync(result.body) : result.body;
  return new TextDecoder().decode(bytes);
};
