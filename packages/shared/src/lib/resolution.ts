/**
 * Trigram similarity floor for FUZZY auto-linking during entity / relation
 * resolution (object-records and link-types `match.ts`).
 *
 * Deliberately high — the product is precision-first: prefer a MISSED match
 * (which safely becomes a `status='suggested'` record/relation for human or
 * agent review) over a false-positive auto-merge that silently pollutes the
 * graph. The exact-normalized and alias stages bypass this entirely
 * (confidence 1.0); this governs ONLY the fuzzy fallback, where distinct names
 * sharing a common word ("Acme Corp" vs "Acme Industries") must NOT merge.
 *
 * pg_trgm `similarity()` runs 0..1 (its default loose threshold is 0.3); 0.8
 * keeps only near-identical strings (typos, punctuation, casing the normalizer
 * missed). Tune here — single source for both resolvers.
 */
export const FUZZY_MATCH_THRESHOLD = 0.8;
