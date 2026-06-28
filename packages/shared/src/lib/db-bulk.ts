import { HTTPException } from "hono/http-exception";

/**
 * Canonical helpers for BULK database writes — the single source of truth for
 * how this codebase inserts/updates/deletes a caller-supplied LIST of rows.
 *
 * The rule everywhere (shared services, API handlers, AI tools, workers): when
 * you write N caller-supplied rows, do it with SET-BASED statements — one
 * multi-row `INSERT`/`DELETE`/`UPDATE … FROM (VALUES …)` per chunk — NEVER a
 * single-row service in a `for` loop. A loop over thousands of rows is N round
 * trips; the batched form is O(chunks). Reach for these helpers instead of
 * re-deriving the constants or re-writing a chunker.
 *
 *  - `MAX_BULK_ITEMS` — hard ceiling a boundary (Zod schema, request handler)
 *    enforces on an incoming bulk payload. Past this, the caller must page.
 *  - `DB_BULK_CHUNK_SIZE` — rows per multi-row statement. Postgres binds at most
 *    65535 parameters per statement; 500 wide rows stay comfortably under it.
 *  - `chunkForBulk(items)` — split a list into `DB_BULK_CHUNK_SIZE` chunks; run
 *    one batched statement (or one transaction of batched statements) per chunk.
 *  - `formatBulkRowError(err)` — flatten a per-row failure to one readable line
 *    for a partial-success result array.
 */

/** Hard ceiling on items accepted in one bulk request. Enforce at the boundary. */
export const MAX_BULK_ITEMS = 5000;

/** Rows per multi-row SQL statement — keeps bound params under Postgres' 65535. */
export const DB_BULK_CHUNK_SIZE = 500;

/**
 * Split a list into fixed-size chunks so each multi-row statement stays under
 * the bound-parameter ceiling while issuing O(chunks) statements, never
 * O(rows). Defaults to {@link DB_BULK_CHUNK_SIZE}.
 */
export const chunkForBulk = <T>(
  items: T[],
  size: number = DB_BULK_CHUNK_SIZE,
): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Flatten a write failure to a single readable line for a per-row error list.
 * `throwHttpError` wraps `{ code, message, details }` as JSON in the
 * `HTTPException.message`; unwrap it so the caller (often an AI agent) sees the
 * field issues, not raw JSON.
 */
export const formatBulkRowError = (error: unknown): string => {
  if (error instanceof HTTPException) {
    try {
      const parsed: unknown = JSON.parse(error.message);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "message" in parsed
      ) {
        const obj = parsed as { message?: unknown; details?: unknown };
        const detail = Array.isArray(obj.details)
          ? ` (${obj.details.join("; ")})`
          : "";
        return `${String(obj.message)}${detail}`;
      }
    } catch {
      // Not JSON — fall through to the raw message.
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
};
