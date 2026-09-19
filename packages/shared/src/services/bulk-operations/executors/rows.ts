/**
 * Reading a streamed load's rows back out of the ledger.
 *
 * A chunk's `items` is jsonb: whatever the caller sent, round-tripped through
 * Postgres. The upload route validated it, but that was hours and one process
 * ago, so the executor re-reads rather than assumes — a row that lost its shape
 * becomes one reported failure instead of a thrown chunk, and a chunk that
 * throws is a chunk whose 2 000 good rows are also refused.
 */

import type { BulkOperationKind } from "../../../db/schema";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ id }` — one target of a streamed delete. */
export const readTargetId = (item: Record<string, unknown>): string | null => {
  const id = item.id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/** `{ id, data }` — one row of a streamed update. */
export const readUpdateRow = (
  item: Record<string, unknown>,
): { id: string; data: Record<string, unknown> } | null => {
  const id = readTargetId(item);
  if (id === null) return null;
  const { data } = item;
  return isRecord(data) ? { id, data } : null;
};

/** The error a row that is not a row earns, said the way the agent can fix it. */
export const MALFORMED_ROW = (shape: string): string =>
  `Row is not ${shape} — it was dropped rather than written.`;

/**
 * What a row of each kind has to look like, checked at UPLOAD rather than only
 * when the chunk is applied.
 *
 * A staged load's rows are parked and applied hours later, so a caller that
 * sent the wrong shape would learn about it after the grant, from a report of
 * 200 000 failures. Refusing the chunk hands the mistake back while the caller
 * can still fix it — and a create carries whatever fields the collection has,
 * so there is nothing to check there beyond its being an object, which the
 * request schema already said.
 */
const rowShapeOf = (
  kind: BulkOperationKind,
): { shape: string; ok: (row: Record<string, unknown>) => boolean } => {
  switch (kind) {
    case "record_update":
      return {
        shape: "`{id, data}`",
        ok: (row) => readUpdateRow(row) !== null,
      };
    case "record_delete":
      return { shape: "`{id}`", ok: (row) => readTargetId(row) !== null };
    case "record_import":
      return { shape: "`{...fields}`", ok: () => true };
  }
};

/** The first row of the wrong shape, if there is one. */
export const firstMalformedRow = (
  kind: BulkOperationKind,
  rows: Record<string, unknown>[],
): { index: number; shape: string } | null => {
  const expected = rowShapeOf(kind);
  const index = rows.findIndex((row) => !expected.ok(row));
  return index === -1 ? null : { index, shape: expected.shape };
};
