/**
 * Typed failures shared by every web adapter, plus the deadline race that
 * produces them.
 *
 * Generalises what the previous stack did for one vendor. The reason it is a typed
 * race rather than "trust the SDK's own timeout" has not changed: an SDK throws
 * a bare `Error` whose message we would have to string-match, and tools must
 * return a structured `{ error, code }` the model can act on ("tools never
 * throw on expected failures").
 */

export type WebOperation = "search" | "fetch" | "map";

export class WebTimeoutError extends Error {
  constructor(
    readonly operation: WebOperation,
    readonly timeoutMs: number,
  ) {
    super(`Web ${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "WebTimeoutError";
  }
}

export class WebProviderUnconfiguredError extends Error {
  constructor(readonly envVar: string) {
    super(`Web tools are not configured on this deployment (${envVar})`);
    this.name = "WebProviderUnconfiguredError";
  }
}

/**
 * A provider was asked for something it cannot express.
 *
 * The search providers are not interchangeable, and the fallback is the place
 * that pretends they are. Perplexity's `mode` picks a CORPUS — `sec` means
 * filings, `academic` means papers — and its `last_updated_after_filter` is a
 * freshness bound; Parallel has neither. Dropping them and answering anyway
 * returns ordinary web pages to a question about filings, or months-old pages
 * to a question that asked for fresh ones, with nothing in the result saying
 * so. Refusing is the honest failure: `searchWithFallback` lets it reach the
 * tool's error envelope, so the model retries with what it can actually get
 * instead of citing a blog post as an SEC filing.
 */
export class WebConstraintUnsupportedError extends Error {
  constructor(
    readonly provider: string,
    readonly constraints: string[],
  ) {
    super(
      `${provider} cannot honour ${constraints.join(", ")}; retry without ${
        constraints.length > 1 ? "those constraints" : "it"
      }`,
    );
    this.name = "WebConstraintUnsupportedError";
  }
}

/**
 * The native abort an SDK performs must fire AFTER our typed race, never at the
 * same instant: the SDK's timer starts when the method is called, one tick
 * before `withWebTimeout` registers its own, so an equal deadline is
 * deterministically won by the SDK and the model receives a generic provider
 * error carrying a raw transport string instead of the `WEB_TIMEOUT` this
 * module exists to produce. Observed in prod on the previous stack (2026-08-14).
 */
const NATIVE_TIMEOUT_GRACE_MS = 2_000;

/** Milliseconds an SDK should wait — always later than our own deadline. */
export const nativeTimeoutMs = (timeoutMs: number): number =>
  timeoutMs + NATIVE_TIMEOUT_GRACE_MS;

/**
 * Race a provider promise against its deadline so the failure is typed. The
 * caller passes the SDK its own (later) timeout alongside, so no work keeps
 * running — and no credit keeps burning — behind a raced-out call.
 */
export const withWebTimeout = async <T>(
  operation: WebOperation,
  timeoutMs: number,
  promise: Promise<T>,
): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new WebTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
};
