/**
 * Cursors for lists walked forward by their uuid-v7 primary key.
 *
 * The whole cursor is the id of the last row served: v7 ids are time-ordered,
 * so `id < :cursor` under `ORDER BY id DESC` is a complete, exact position —
 * one unique key, one index, no ties.
 *
 * Why not a `(created_at, id)` pair, which would follow a list's usual
 * "newest first" ordering exactly: Postgres keeps `timestamptz` to the
 * microsecond and a JavaScript `Date` only to the millisecond, so a cursor
 * built from a fetched row carries a TRUNCATED timestamp. Compared back
 * against the column it excludes every row inside that microsecond — rows the
 * walk had never served. Measured on a 4 995-row import: the walk returned 21
 * rows and declared itself finished. A key the application can round-trip
 * exactly is worth more than a hair of ordering fidelity, and `created_at`
 * only ever disagrees with the id order by the gap between a transaction's
 * start and its insert.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cursor to walk from, or null to start at the beginning.
 *
 * Anything that is not an id shape is null rather than an error: a cursor
 * comes from a tab left open across a deploy or a truncated URL far more often
 * than from a bug, and restarting the walk is the harmless answer. It also
 * keeps a hand-written value out of a `::uuid` cast, which Postgres would
 * reject as a 500.
 */
export const idCursor = (raw: string | undefined | null): string | null =>
  typeof raw === "string" && UUID.test(raw) ? raw : null;
