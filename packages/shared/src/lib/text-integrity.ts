/**
 * Characters a model emits that no legitimate answer contains, and the
 * stream-safe scanner that counts them.
 *
 * Two readers share these definitions and neither may drift from the other: the
 * page autofixer, which REPAIRS them before a compile (`services/pages/
 * autofix.ts`), and the runtime detectors, which COUNT them and file an
 * incident against the serving upstream (`@fretik/ai` `lib/model-detectors.ts`).
 * A character one of them knows and the other does not is either a defect that
 * repeats forever or a provider quarantined for something we silently fix.
 *
 * MEASURED 2026-08-28, reproduced 2 runs out of 3: CoreWeave serving
 * `deepseek-v4-flash` inserted U+200B and fullwidth forms next to NUMERIC
 * tokens — `Net 1.200, T.Net <U+200B>4.800, Total <U+200B>314.88`. It breaks
 * generated code and spreadsheets outright, it cannot be found by reading the
 * line, and it SELF-PROPAGATES: the corrupted answer re-enters the next turn as
 * the model's own prior output. The host was pulled from the pool by hand,
 * which is the cost this module exists to remove.
 *
 * Every codepoint below is written as an escape on purpose. Pasted literally
 * they are unreviewable, which is the whole point of the defect.
 */

/** Zero-width space/non-joiner/joiner, bidi marks, overrides, isolates, BOM. */
export const ZERO_WIDTH_AND_BIDI =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{FEFF}]/gu;

/**
 * A fullwidth form ADJACENT to an ASCII digit.
 *
 * The character alone proves nothing: a fullwidth parenthesis is ordinary
 * Japanese, and a detector that flagged it would quarantine a host for writing
 * correct CJK. Next to a Western number it is not prose, it is the substitution
 * measured on 2026-08-28 — `Total <U+FF09>314.88`. Adjacency to a digit is the
 * entire discriminator.
 *
 * U+FF01–FF5E are the fullwidth ASCII variants, U+FF5F–FF60 the fullwidth white
 * parentheses. Ideographic punctuation (U+3001, U+3002) is deliberately absent:
 * a Japanese date ends on one right after a digit, legitimately.
 *
 * The residual false positive is a CJK sentence that parenthesises a number.
 * It is accepted rather than engineered away — the breaker needs two
 * corroborating GENERATIONS inside 30 minutes before it acts, and a fleet whose
 * answers are French and English does not produce that pair by accident.
 */
export const FULLWIDTH_NEAR_DIGIT =
  /(?<=[0-9])[\u{FF01}-\u{FF60}]|[\u{FF01}-\u{FF60}](?=[0-9])/gu;

/** The patterns the runtime counts, in the order their hits are reported. */
const PATTERNS: readonly RegExp[] = [ZERO_WIDTH_AND_BIDI, FULLWIDTH_NEAR_DIGIT];

/**
 * Characters of left context a scan needs, and therefore the length of the
 * `carry` a streaming caller keeps between chunks. Exported so the detector and
 * its tests agree on one number instead of each assuming it.
 */
export const SCAN_CARRY_LENGTH = 1;

export interface ForbiddenScan {
  /** `U+XXXX` → occurrences. Shared and frozen when empty; never mutate it. */
  hits: Readonly<Record<string, number>>;
  total: number;
  /** Feed back into the next call. Empty when the last character was a hit. */
  carry: string;
}

const NO_HITS: Readonly<Record<string, number>> = Object.freeze({});

const codepointKey = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Count forbidden codepoints in one chunk of a stream.
 *
 * NEVER RETURNS THE TEXT. These streams are customer documents and
 * conversations; a corruption detector is not a licence to copy them into an
 * infra table. Codepoints and counts are the whole output, and they are enough
 * to name the defect.
 *
 * `carry` is the previous chunk's last character, prepended so a defect needing
 * one character of context — a fullwidth form whose digit landed in the next
 * delta — is still seen. It comes back EMPTY when that character was itself
 * counted, which is what makes the tally exact: a character is either already
 * accounted for (dropped) or offered once more as context, never both.
 *
 * Allocation-free on clean text: two `exec` calls that return null, one
 * one-character slice, and the shared empty `hits`. No array, map or object is
 * built until something is actually found. The patterns are module-level and
 * `g`-flagged, so `lastIndex` is reset before every scan.
 */
export const scanForbiddenCodepoints = (
  text: string,
  carry = "",
): ForbiddenScan => {
  if (text.length === 0) return { hits: NO_HITS, total: 0, carry };
  const window = carry + text;
  let hits: Record<string, number> | undefined;
  let total = 0;
  let lastCounted = false;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(window);
      match !== null;
      match = pattern.exec(window)
    ) {
      const found = match[0];
      for (const char of found) {
        const key = codepointKey(char);
        hits ??= {};
        hits[key] = (hits[key] ?? 0) + 1;
        total += 1;
      }
      if (match.index + found.length === window.length) lastCounted = true;
    }
  }
  return {
    hits: hits ?? NO_HITS,
    total,
    carry: lastCounted ? "" : text.slice(-SCAN_CARRY_LENGTH),
  };
};
