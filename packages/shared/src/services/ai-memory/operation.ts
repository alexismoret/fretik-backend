import type { AiMemoryOperation } from "../../db/schema/ai-memory";

/**
 * Narrow a `text` column from `ai_memory_history.operation` into the
 * `AiMemoryOperation` union without an `as` cast. Drizzle types the
 * column as `string` (the schema uses `text()` to keep migrations
 * cheap when we add a new operation), so we re-validate on read.
 *
 * Throws on unknown values rather than returning `undefined` — an
 * unrecognised operation in the audit table is a data-integrity bug
 * we want surfaced loudly, not silently dropped from the activity feed.
 */
export const parseMemoryOperation = (raw: string): AiMemoryOperation => {
  if (
    raw === "create" ||
    raw === "overwrite" ||
    raw === "rename" ||
    raw === "delete"
  ) {
    return raw;
  }
  throw new Error(`Unknown ai_memory_history.operation value: ${raw}`);
};
