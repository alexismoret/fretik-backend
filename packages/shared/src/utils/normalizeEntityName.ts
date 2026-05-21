/**
 * Legal suffixes to strip from company names during normalization.
 * Matches whole words only (word boundaries).
 */
const LEGAL_SUFFIXES =
  /\b(sa|sas|sarl|eurl|sasu|sci|snc|sca|scop|sem|gie|earl|ltd|limited|inc|incorporated|gmbh|llc|plc|ag|nv|bv|se|co|corp|corporation|pty|pvt|kg|ohg|ug|ab|oy|oyj|as|asa|spa|srl|kk|bhd|sdn|pte|hk|sprl|cvba|vof)\b/gi;

/**
 * Normalizes an entity name for matching purposes.
 *
 * - Lowercases
 * - Removes legal suffixes (SA, SAS, Ltd, Inc, GmbH, etc.)
 * - Removes punctuation (hyphens, dots, commas, apostrophes, parentheses, quotes)
 * - Collapses multiple spaces into one
 * - Trims whitespace
 *
 * Examples:
 *   "Acme Solutions S.A."  → "acme solutions"
 *   "Globex Industries SAS" → "globex industries"
 *   "INITECH A/S"          → "initech"
 *   "Stark, Inc."          → "stark"
 */
export const normalizeEntityName = (name: string): string =>
  name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, "")
    .replace(/[.\-,'"()/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
