/**
 * Derive a stable `field_definitions.key` slug from a free-form label.
 *
 * The key column carries the regex
 *   ^[a-z][a-z0-9_]{0,58}[a-z0-9]$ | ^[a-z]$
 * (lowercase letters / digits / underscores, starting with a letter,
 * ending with an alphanumeric, ≤ 60 chars). This helper guarantees the
 * output matches: strip diacritics, collapse non-alphanumeric runs to
 * underscores, trim edges, prefix `f_` when the first char would be a
 * digit, and cap the length.
 *
 * Edge cases: an empty input returns `field` so callers always get a
 * persistable value (validated downstream by `validateFieldDefinitionShape`).
 */
export const slugifyFieldKey = (label: string): string => {
  let s = (label ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  if (!s) return "field";

  // First char must be a letter — prefix with `f_` if it's a digit.
  if (/^[0-9]/.test(s)) s = `f_${s}`.slice(0, 60);

  // Last char must be alphanumeric (slice may have left a trailing `_`).
  s = s.replace(/_+$/, "");

  // Single-letter fallback or normal multi-char slug — both are valid.
  return s.length > 0 ? s : "field";
};
