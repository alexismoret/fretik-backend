/**
 * Deterministic secret redaction — a defense-in-depth net for text distilled
 * into long-term memory. The distill prompts already tell the model to keep
 * secrets out (P8.2), but a utility-tier model copies a live key through
 * regardless — and it also cosmetically reformats it (observed live: an
 * `sk-live-…` key rewritten with U+2011 non-breaking hyphens), which would
 * slip an ASCII regex. So detection runs over a normalized copy where
 * confusable hyphens/spaces fold to ASCII (position-preserving, 1:1), and the
 * matched spans are redacted in the ORIGINAL text — non-secret content stays
 * byte-identical. Conservative on shapes: only well-known credential formats,
 * so ordinary business text is never mangled. PII is NOT covered (it has no
 * shape); the prompt guard is its only line.
 */

const REDACTED = "[redacted]";

/** Provider key / token shapes (global — used with matchAll). */
const SECRET_PATTERNS: RegExp[] = [
  // Stripe-style scoped keys: sk_live_…, pk_test_…, rk_live_…
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // OpenAI / generic `sk-` keys (incl. sk-live-…, sk-proj-…)
  /\bsk-[A-Za-z0-9-]{12,}\b/g,
  // GitHub tokens
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JWT (three base64url segments)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Bearer tokens — redact the token, keep the scheme word. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g;

// Confusable hyphens/dashes and unicode spaces the model substitutes for
// ASCII — each maps 1 char -> 1 char, so normalized positions stay aligned
// with the original for span-accurate redaction. Ranges: U+2010..U+2015
// (hyphen..horizontal bar), U+2212 (minus), U+FE58/U+FE63/U+FF0D (small/
// full-width hyphens); spaces: NBSP, U+2000..U+200A, U+202F, U+205F, U+3000.
const CONFUSABLE_HYPHENS = /[‐-―−﹘﹣－]/g;
const UNICODE_SPACES = /[  -   　]/g;

const normalizeForDetection = (text: string): string =>
  text.replace(CONFUSABLE_HYPHENS, "-").replace(UNICODE_SPACES, " ");

interface Span {
  start: number;
  end: number;
}

export const redactSecrets = (text: string): string => {
  const probe = normalizeForDetection(text);
  const spans: Span[] = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const m of probe.matchAll(pattern)) {
      if (m.index !== undefined) {
        spans.push({ start: m.index, end: m.index + m[0].length });
      }
    }
  }
  for (const m of probe.matchAll(BEARER_PATTERN)) {
    if (m.index === undefined) continue;
    // Keep "Bearer " (scheme + whitespace), redact only the token span.
    const tokenOffset = m[0].length - m[0].replace(/^Bearer\s+/, "").length;
    spans.push({ start: m.index + tokenOffset, end: m.index + m[0].length });
  }
  if (spans.length === 0) return text;

  // Walk the ORIGINAL text (positions align with `probe`), splicing each
  // matched span with the marker; skip spans already covered by an earlier one.
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out += text.slice(cursor, s.start) + REDACTED;
    cursor = s.end;
  }
  return out + text.slice(cursor);
};
