/**
 * Anti-buffering headers for any SSE endpoint.
 *
 * Fretik has historically observed `ERR_INCOMPLETE_CHUNKED_ENCODING 200`
 * errors in the browser on several SSE streams. The Hono/Bun close-race
 * bug is addressed by `sse-utils.ts::streamStatusEvents`; this constant
 * covers the other half of the problem: intermediate proxies, gzip
 * negotiation and client caches buffering the stream instead of
 * forwarding each chunk immediately.
 *
 * Apply these headers to every SSE response (both Hono `streamSSE`
 * handlers and bare `new Response(stream)` returns).
 */
export const ANTI_BUFFERING_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  // Nginx / Cloud Run / Vercel edge — disable proxy buffering.
  "X-Accel-Buffering": "no",
  // NOTE: no explicit `Content-Encoding: identity` — some proxies/CDNs
  // mishandle the explicit header on chunked responses (observed as
  // buffered/stalled SSE); `no-transform` above already forbids
  // intermediaries from compressing, and neither service runs a
  // compression middleware.
  Connection: "keep-alive",
} as const;

/**
 * Apply the anti-buffering headers to a Hono context BEFORE returning
 * `streamSSE(c, ...)`. Hono's `streamSSE` already sets `Content-Type`,
 * `Cache-Control: no-cache`, `Connection`, and `Transfer-Encoding`;
 * we extend those with `no-transform` and `X-Accel-Buffering: no` so
 * intermediate proxies and gzip layers don't buffer chunks and trigger
 * `ERR_INCOMPLETE_CHUNKED_ENCODING` on the browser.
 */
export const applyAntiBufferingHeaders = (c: {
  header: (name: string, value: string) => void;
}): void => {
  // Overrides Hono's default `no-cache` so proxies also see `no-transform`.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
};
