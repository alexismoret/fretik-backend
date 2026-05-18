/**
 * Hard limits enforced by the create/update/batch-apply/ai-suggest services
 * to keep the pre-extract pipeline well-bounded. Tweak with care — the
 * pre-extract LLM prompt budget is calibrated around these caps.
 */
export const FIELD_DEFINITION_LIMITS = {
  /** Max enabled definitions per (org or team) scope, all resource types combined. */
  MAX_ENABLED_PER_SCOPE: 15,
  /** Max `options[]` length on a single select / multi_select field. */
  MAX_OPTIONS_PER_FIELD: 50,
  /** Max length of `description` (which doubles as the LLM `.describe()`). */
  MAX_DESCRIPTION_CHARS: 500,
  /** Max length of `label`. */
  MAX_LABEL_CHARS: 80,
} as const;

/**
 * Slug grammar for `fieldDefinitions.key`: lowercase alphanum + underscores,
 * starts with a letter, 1-60 chars total. Matches the column varchar(60).
 */
export const FIELD_DEFINITION_KEY_REGEX =
  /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/;
