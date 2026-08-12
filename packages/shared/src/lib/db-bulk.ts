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
 *  - `DB_BULK_CHUNK_SIZE` — rows per multi-row statement when the row width is
 *    unknown. Postgres binds at most 65535 parameters per statement.
 *  - `chunkSizeForParams(paramsPerRow)` — the size to PREFER when the width IS
 *    known (it always is for a typed table): derives the row count from what one
 *    row binds, instead of a fixed guess that is wrong at both ends.
 *  - `chunkForBulk(items, size?)` — split a list into chunks; run one batched
 *    statement (or one transaction of batched statements) per chunk.
 *  - `formatBulkRowError(err)` — flatten a per-row failure to one readable line
 *    for a partial-success result array.
 */

/** Hard ceiling on items accepted in one bulk request. Enforce at the boundary. */
export const MAX_BULK_ITEMS = 5000;

/** Rows per multi-row SQL statement — keeps bound params under Postgres' 65535. */
export const DB_BULK_CHUNK_SIZE = 500;

/** Postgres binds at most this many parameters in one statement. */
export const PG_MAX_BIND_PARAMS = 65_535;

/**
 * Headroom left under {@link PG_MAX_BIND_PARAMS}. A chunk's row count is
 * derived from ONE statement's shape, but a chunk usually runs a few statements
 * whose widths differ; the margin means a caller that under-counts by a column
 * or two still lands well inside the ceiling.
 */
const BIND_PARAM_SAFETY = 0.8;

/** Never go below this: tiny chunks turn one round-trip into hundreds. */
export const MIN_BULK_CHUNK_SIZE = 200;
/** Never go above this: a huge chunk holds a long transaction and a big heap. */
export const MAX_BULK_CHUNK_SIZE = 2_000;

/**
 * Rows per statement for a table that binds `paramsPerRow` parameters per row.
 *
 * The fixed {@link DB_BULK_CHUNK_SIZE} is a compromise that is wrong at both
 * ends, because the parameter count per row is the TYPE's, not the codebase's:
 * a 5-column type wastes four fifths of every round-trip, while a 100-column
 * one binds ~52 000 parameters per statement and sits one field away from the
 * hard ceiling. Deriving the row count from the width fixes both.
 *
 * The floor is deliberately NOT allowed to win against the real ceiling — a
 * very wide type is exactly where raising the row count back up would overflow
 * the parameter limit, which is the failure this function exists to prevent.
 */
export const chunkSizeForParams = (paramsPerRow: number): number => {
  if (!Number.isFinite(paramsPerRow) || paramsPerRow <= 0) {
    return DB_BULK_CHUNK_SIZE;
  }
  const fit = Math.floor(
    (PG_MAX_BIND_PARAMS * BIND_PARAM_SAFETY) / paramsPerRow,
  );
  if (fit >= MIN_BULK_CHUNK_SIZE) return Math.min(fit, MAX_BULK_CHUNK_SIZE);
  // Too wide for the floor: take the floor only as far as the ceiling allows.
  return Math.max(
    1,
    Math.min(
      MIN_BULK_CHUNK_SIZE,
      Math.floor(PG_MAX_BIND_PARAMS / paramsPerRow),
    ),
  );
};

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
