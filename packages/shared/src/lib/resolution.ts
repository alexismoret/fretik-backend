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

/**
 * Minimum LLM confidence (0..1) for an AI-extracted mention to CREATE a new
 * `suggested` record. Below it, the mention still links to an already-existing
 * record (any confidence) but never spawns a fresh stub — keeps the review queue
 * from filling with low-confidence guesses. A mention with no confidence value is
 * treated as passing (the model simply omitted its self-assessment). Governs only
 * the create path; matching is unaffected. Distinct from the RESOLUTION_*
 * bands below, which govern how the async resolver TRUSTS a match against an
 * EXISTING record (linking regime, not creation).
 */
export const MENTION_MIN_CONFIDENCE = 0.5;

/**
 * The async event→graph resolver's trust bands for `domain_event_links` it
 * infers (`source='ai_inference'`):
 *   match confidence ≥ AUTO    → `status='confirmed'` (auto-linked)
 *   AUTO > confidence ≥ SUGGEST → `status='suggested'` (review band)
 *   below SUGGEST              → dropped.
 * Precision-first, like FUZZY_MATCH_THRESHOLD above: memory recall treats
 * confirmed links as facts, so a wrong auto-link pollutes every future recall.
 */
export const RESOLUTION_AUTO_THRESHOLD = 0.85;
export const RESOLUTION_SUGGEST_THRESHOLD = 0.5;
