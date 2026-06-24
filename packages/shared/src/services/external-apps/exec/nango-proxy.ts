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

export const callNangoProxy = async (
  call: NangoProxyCall,
): Promise<unknown> => {
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
    throw error;
  }
};
