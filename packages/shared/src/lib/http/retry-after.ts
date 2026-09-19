/**
 * "Come back in…", in the four shapes the web actually sends it.
 *
 * RFC 9110 defines exactly two for `Retry-After` — a delta in seconds, or an
 * HTTP-date — and a real catalogue of APIs sends neither half the time. The two
 * extras here are not hospitality: `x-ratelimit-reset` is an epoch, in seconds
 * on most APIs and in milliseconds on some, and a parser that reads
 * `1789543210` as a delta would sleep for fifty-six years.
 *
 * Returns milliseconds, or `undefined` when the value says nothing — never a
 * guess. The caller decides what an absent answer is worth, because "wait the
 * default" and "this header was garbage" are different facts and only one of
 * them is worth logging.
 */

/** Epoch seconds below this are read as a delta; above, as an absolute time. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;

/** `Date.parse` accepts a bare number; a date must look like one. */
const looksLikeDate = (value: string): boolean => /[A-Za-z]/.test(value);

export const parseRetryAfter = (
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;

  if (looksLikeDate(raw)) {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, at - now);
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;

  // Epoch milliseconds — what a few APIs put in `x-ratelimit-reset`.
  if (numeric >= EPOCH_SECONDS_FLOOR * 1000) {
    return Math.max(0, numeric - now);
  }
  // Epoch seconds. The floor is what separates them from a delta: no API asks
  // a client to wait 31 years, and every epoch since 2001 is above it.
  if (numeric >= EPOCH_SECONDS_FLOOR) {
    return Math.max(0, numeric * 1000 - now);
  }
  // A delta, in seconds — the RFC's own form.
  return Math.round(numeric * 1000);
};

/**
 * The first of several headers that parses. Providers disagree about the name
 * far more than about the meaning — Nango's own proxy config names `retry.after`
 * or `retry.at` per integration — so the ORDER is the contract: the standard
 * header first, then whatever the provider declared, then the common vendor
 * spellings.
 */
export const retryAfterFromHeaders = (
  headers: Record<string, string | undefined>,
  extraNames: readonly string[] = [],
  now: number = Date.now(),
): number | undefined => {
  const lower: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value;
  }
  const names = [
    "retry-after",
    ...extraNames.map((name) => name.toLowerCase()),
    "x-ratelimit-reset",
    "x-rate-limit-reset",
    "ratelimit-reset",
  ];
  for (const name of names) {
    const parsed = parseRetryAfter(lower[name], now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};
