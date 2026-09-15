import {
  arr,
  asString,
  isRecord,
  prop,
} from "../../../external-apps/json-access";
import type { HttpMethod } from "../../../external-apps/manifest-schema";
import { isAuthFailure } from "../../../lib/external-apps/detect-auth-failure";
import { getNangoClient } from "../../../lib/external-apps/nango-client";
import { markConnectionAsError } from "../connections/mark-as-error";

/**
 * Thin wrapper around `nango.proxy(...)`. Centralises the call so every
 * provider's mappers use the same retries policy and the same way of
 * passing query/body — and so a future swap (caching, alternate
 * transports) is a one-file change.
 *
 * Retries — Nango itself retries 5xx + 429 with exponential backoff
 * when `retries > 0`. We default to 3; mappers needing different
 * semantics can be wrapped at a higher layer.
 *
 * Auth failure detection — on a thrown error, `isAuthFailure` inspects
 * the Nango response shape and, when it matches a durable failure
 * (refresh expired, scope revoked, …), `markConnectionAsError` flips
 * the row's `status` to `error` so the frontend renders the Reconnect
 * CTA. The original error is always re-thrown — the wrapper is purely
 * additive.
 *
 * Pagination — `paginate: true` follows OData `@odata.nextLink` and
 * concatenates every page's `value[]` into one synthetic
 * `{ value: [...all] }` response BEFORE the provider's response mapper
 * runs. Required for Microsoft Graph collections that page server-side
 * (e.g. Planner caps task lists at ~400/page and the caller must walk
 * `@odata.nextLink` to see the rest — otherwise a 600-task plan silently
 * returns only its first 400). Opt-in per action so non-collection reads
 * and intentionally-bounded lists (Outlook `$top`) keep single-page
 * behaviour.
 */

export interface NangoProxyCall {
  providerConfigKey: string;
  connectionId: string;
  method: HttpMethod;
  /** Path part — base URL is filled in by Nango from the integration. */
  endpoint: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Per-call request headers (e.g. Planner's `If-Match: <etag>`). */
  headers?: Record<string, string>;
  /** Follow `@odata.nextLink` and aggregate all pages (collection reads). */
  paginate?: boolean;
}

/**
 * Hard ceiling on pages walked — a safety valve against an unbounded loop,
 * not an expected limit. 25 × ~400 items/page = 10k items, above Planner's
 * 9k max-tasks-per-plan. A capped walk logs and returns what it has.
 */
const MAX_PAGES = 25;

/**
 * Wall-clock ceiling on one `callNangoProxy` — the whole pagination walk
 * included.
 *
 * Without it the call is unbounded from our side: `@nangohq/node` builds its
 * axios instance with no `timeout`, and `ProxyConfiguration` exposes neither
 * a `timeout` nor a `signal`, so nothing we pass can shorten it. On the far
 * side Nango honours the provider's `Retry-After` up to
 * `NANGO_PROXY_MAX_RETRY_WAIT_MS` (10 minutes by default, introduced in
 * v0.71.6) before each of the `retries: 3` attempts — a rate-limited Graph
 * call can therefore keep our request open for many minutes.
 *
 * `@fretik/api` serves with `idleTimeout: 30`, and Bun applies that to a
 * request whose HANDLER is slow, not merely to an idle socket. Past it the
 * sandbox does not get an error, it loses the connection — the agent is told
 * nothing and cannot say whether the write landed. Finishing first, with a
 * message naming the cause, is strictly better.
 *
 * Raise this if `idleTimeout` is ever raised; it is deliberately the smaller
 * of the two.
 */
const PROXY_DEADLINE_MS = 25_000;

export class ProxyDeadlineError extends Error {
  constructor(seconds: number) {
    super(
      `The provider did not answer within ${seconds.toString()}s. It is usually rate-limiting us: Nango waits out the provider's Retry-After before retrying, and that can outlast a chat turn. Retry in a minute, or ask for less in one call.`,
    );
    this.name = "ProxyDeadlineError";
  }
}

/**
 * Reject with a `ProxyDeadlineError` if `work` has not settled in time.
 *
 * The underlying request is NOT cancelled — the SDK gives us no handle to
 * cancel it with — so it runs on and whatever it returns is dropped. The
 * explicit `catch` is belt-and-braces against a late rejection: `race`
 * already subscribes to `work`, so this only matters if that ever changes.
 */
const withProxyDeadline = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProxyDeadlineError(Math.round(PROXY_DEADLINE_MS / 1000)));
        }, PROXY_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void work.catch(() => undefined);
  }
};

/**
 * Nango answers HTTP 413 `request_too_large` when the body we handed it
 * exceeds its proxy router's 1 MB limit (the limit is long-standing; the
 * named code arrived in v0.71.6 — before it, the same refusal came back as
 * an opaque failure).
 *
 * This is reachable from any action that carries a file: Outlook sends
 * attachments as base64 `contentBytes` inside the message body, and base64
 * inflates by a third, so it is roughly a 750 KB file. The generic error
 * reads like a provider fault; the file is the fault, and the agent can act
 * on that.
 */
const REQUEST_TOO_LARGE_HINT =
  "The request body was too large for the connector's 1 MB limit. If it carries an attachment, send a smaller file or a link to it — base64 adds a third to a file's size, so the ceiling is around 750 KB of actual file.";

const isRequestTooLarge = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { response?: { status?: number }; status?: number };
  // Status alone, not the body's `code`: 413 has exactly one meaning on this
  // route, and an instance older than v0.71.6 answers it with no code at all.
  return (e.response?.status ?? e.status) === 413;
};

/** Split an absolute `@odata.nextLink` into a Nango proxy `{ endpoint, query }`. */
const splitNextLink = (
  nextLink: string,
): { endpoint: string; query: Record<string, string> } => {
  const url = new URL(nextLink);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return { endpoint: url.pathname, query };
};

const proxyOnce = async (call: NangoProxyCall): Promise<unknown> => {
  const nango = getNangoClient();
  const res = await nango.proxy({
    method: call.method,
    endpoint: call.endpoint,
    providerConfigKey: call.providerConfigKey,
    connectionId: call.connectionId,
    params: call.query,
    data: call.body,
    headers: call.headers,
    retries: 3,
  });
  return res.data;
};

export const callNangoProxy = async (call: NangoProxyCall): Promise<unknown> =>
  await withProxyDeadline(runProxyCall(call));

const runProxyCall = async (call: NangoProxyCall): Promise<unknown> => {
  try {
    const first = await proxyOnce(call);
    if (call.paginate !== true) return first;

    // Aggregate every page's `value[]`. `@odata.nextLink` is an absolute
    // URL; we re-issue it through the proxy as path + query so Nango still
    // injects the integration's base URL + auth.
    const items: unknown[] = [...arr(prop(first, "value"))];
    let nextLink = asString(prop(first, "@odata.nextLink"));
    let pages = 1;
    while (nextLink !== undefined && pages < MAX_PAGES) {
      const { endpoint, query } = splitNextLink(nextLink);
      const page = await proxyOnce({
        ...call,
        endpoint,
        query,
        body: undefined,
      });
      items.push(...arr(prop(page, "value")));
      nextLink = asString(prop(page, "@odata.nextLink"));
      pages += 1;
    }
    if (nextLink !== undefined) {
      console.warn(
        `callNangoProxy: pagination hit MAX_PAGES (${MAX_PAGES.toString()}) for ${call.providerConfigKey} ${call.endpoint} — result truncated at ${items.length.toString()} items`,
      );
    }
    // Preserve the first page's non-`value` envelope keys (e.g. `@odata.context`)
    // while replacing `value` with the merged list.
    return isRecord(first) ? { ...first, value: items } : { value: items };
  } catch (error) {
    const detected = isAuthFailure(error);
    if (detected.matched) {
      await markConnectionAsError({
        nangoConnectionId: call.connectionId,
        nangoProviderConfigKey: call.providerConfigKey,
        reason: detected.reason,
      }).catch(() => undefined);
    }
    // Re-thrown as a plain Error on purpose: the axios error's own message is
    // `Request failed with status code 413`, which sends the agent looking at
    // the provider instead of at the file it just attached.
    if (isRequestTooLarge(error))
      throw new Error(REQUEST_TOO_LARGE_HINT, { cause: error });
    throw error;
  }
};
