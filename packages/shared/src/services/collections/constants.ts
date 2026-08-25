/**
 * Key of the one delete-protected system collection. Each record of this type
 * is the 1:1 graph mirror of an uploaded file (`collection_records.document_id →
 * documents.id`): it holds the file's extracted metadata + its `mentions` edges,
 * NOT the binary (that lives in the `documents` table / Drive). Named
 * `document_record` — not `document` — so it never reads as the raw `documents`
 * table in code, SQL, prompts, or a future session. The upload→graph fold and
 * the document-field templates resolve the type through this constant.
 */
export const DOCUMENT_COLLECTION_KEY = "document_record";

/**
 * Hard limits on a collection's own columns. The `description` cap is the
 * single source aligned across the AI tools, the Python SDK, the API schema, and
 * the settings form — a type description is a tight one-line gloss of what the
 * type is for (the agent reads it as ground truth), not a paragraph.
 */
export const COLLECTION_LIMITS = {
  /** Max length of a type `description`. */
  MAX_DESCRIPTION_CHARS: 240,
  /** Max length of a type `label`. */
  MAX_LABEL_CHARS: 80,
} as const;
