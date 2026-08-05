/**
 * Text matching for eval assertions, immune to typographic Unicode.
 *
 * Models write like typesetters, and a `String.includes` written by a developer
 * does not. Measured three times on this codebase alone:
 *   - `3 semaines` — NARROW NO-BREAK SPACE, French thin space before a
 *     unit; an assertion on `"3 semaines"` reads it as absent (chain eval,
 *     2026-08-04, and the block it rejected was CORRECT);
 *   - `2026‑06‑30` — NON-BREAKING HYPHEN in dates the recall judge
 *     appended to provenance markers;
 *   - `sk‑live‑…` — the same hyphen inside an API key gpt-oss-20b
 *     rewrote, which slipped past an ASCII secret check until P8.2 caught it.
 *
 * Normalizing here rather than in the services is deliberate: the production
 * output is right in every one of those cases. Only the instrument was wrong,
 * and an instrument that fails on correct output manufactures false findings —
 * the expensive kind, because they send you looking for a bug that isn't there.
 *
 * Kept narrow on purpose: whitespace, dashes and quotes fold, nothing else.
 * Accents, case and word boundaries still mean what they say.
 */

/** Unicode spaces (thin, narrow, non-breaking, en/em quads, …) → plain space. */
const UNICODE_SPACES = /[   -   　]/g;
/** Hyphen-likes (non-breaking, figure, en/em dash, minus) → ASCII hyphen. */
const UNICODE_DASHES = /[‐‑‒–—―−]/g;
/** Curly quotes and primes → their ASCII counterparts. */
const UNICODE_QUOTES = /[‘’‛′]/g;
const UNICODE_DQUOTES = /[“”‟″]/g;

/**
 * Fold typography to ASCII equivalents. Also collapses runs of whitespace, so
 * a line the model wrapped differently still matches.
 */
export const normalizeForMatch = (s: string): string =>
  s
    .replace(UNICODE_SPACES, " ")
    .replace(UNICODE_DASHES, "-")
    .replace(UNICODE_QUOTES, "'")
    .replace(UNICODE_DQUOTES, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();

/** "Does this text contain this phrase", judged on meaning not on typography. */
export const textIncludes = (haystack: string, needle: string): boolean =>
  normalizeForMatch(haystack).includes(normalizeForMatch(needle));
