import { assertFetchableTarget } from "../web-egress";
import { mapUserAgent } from "./config";

/**
 * The one place this service fetches the open web itself.
 *
 * Everything an agent reads goes through a provider — `webFetch` runs on
 * Parallel's headless browser precisely so page retrieval happens on their
 * egress and not from our single datacenter address. The exception is site
 * discovery: `robots.txt` and `sitemap.xml` are published FOR robots, are
 * served as static text by the origin rather than by a bot-detection layer,
 * and cost nothing. That narrow case is what this helper exists for, and it is
 * deliberately not exported as a general fetch.
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
  /**
   * Explicitly backed by an `ArrayBuffer`, not the default `ArrayBufferLike`:
   * `Bun.gunzipSync` refuses a possibly-shared buffer, and the copy below
   * always allocates a plain one.
   */
  body: Uint8Array<ArrayBuffer>;
}

/**
 * Fetch a public URL with the full guard rail. Throws `WebEgressError` when a
 * target — original or redirected — is not a legitimate public destination.
 */
export const safeFetch = async (
  url: string,
  { timeoutMs, maxBytes = MAX_BYTES }: { timeoutMs: number; maxBytes?: number },
): Promise<SafeFetchResult> => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-validated on EVERY hop, not just the first.
      assertFetchableTarget(current);

      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": mapUserAgent(),
          Accept: "text/plain, application/xml, text/xml, */*;q=0.5",
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

      return {
        finalUrl: current,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await readCapped(response, maxBytes),
      };
    }

    throw new WebHttpError(`More than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(deadline);
  }
};

/**
 * Read a response body, stopping at `maxBytes`.
 *
 * Streamed rather than `arrayBuffer()`d on purpose: `Content-Length` is a hint
 * a hostile origin controls, so the cap has to be enforced against the bytes
 * that actually arrive.
 */
const readCapped = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    chunks.push(value);
    total += value.byteLength;

    if (total >= maxBytes) {
      await reader.cancel();
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
