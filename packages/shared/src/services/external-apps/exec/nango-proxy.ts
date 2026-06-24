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
}

export const callNangoProxy = async (
  call: NangoProxyCall,
): Promise<unknown> => {
  const nango = getNangoClient();
  try {
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
