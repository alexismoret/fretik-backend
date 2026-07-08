import type {
  ToolApprovalRecordResult,
  ToolApprovalRecordWritePayload,
  ToolApprovalResult,
} from "../../../db/schema";

/**
 * Pure mapping from stored `record_write` results back to the wire shape the
 * DIRECT bulk path returns — kept dependency-free (types only) so the sandbox
 * re-run contract can be unit-tested without loading the DB client.
 */

const isOk = (
  r: ToolApprovalRecordResult,
): r is { ok: true; id: string; label: string } => "ok" in r && r.ok;

const isErr = (
  r: ToolApprovalRecordResult,
): r is { ok: false; error: string } => "ok" in r && !r.ok;

const isRecordResultItem = (x: unknown): x is ToolApprovalRecordResult =>
  typeof x === "object" &&
  x !== null &&
  ("skipped" in x || "id" in x || "error" in x);

/** Narrow the kind-generic `result` union to the record-write shape. Safe at
 * runtime: a `record_write` row's `result` is always `ToolApprovalRecordResult[]`. */
export const asRecordResults = (
  result: ToolApprovalResult | null,
): ToolApprovalRecordResult[] =>
  Array.isArray(result) ? result.filter(isRecordResultItem) : [];

/**
 * Reconstruct the wire dict the DIRECT bulk path returns, per op, from the
 * stored per-item results — so a Python re-run of the same gated code gets back
 * the same shape it would on an autonomous/direct call (`{ids,…}` for create,
 * `{updatedIds,…}` for update, `{deletedIds,…}` for delete). Failed-item ids for
 * update/delete are recovered from the payload's item at that index (the stored
 * `{ok:false,error}` carries no id).
 */
export const recordWriteWire = (
  payload: ToolApprovalRecordWritePayload,
  results: ToolApprovalRecordResult[],
): Record<string, unknown> => {
  const okCount = results.filter(isOk).length;
  if (payload.op === "create") {
    return {
      ids: results.map((r) => (isOk(r) ? r.id : null)),
      okCount,
      errors: results.flatMap((r, i) =>
        isErr(r) ? [{ index: i, error: r.error }] : [],
      ),
      relationErrors: [],
    };
  }
  const errors = results.flatMap((r, i) =>
    isErr(r) ? [{ id: payload.items[i]?.recordId ?? "", error: r.error }] : [],
  );
  const okIds = results.flatMap((r) => (isOk(r) ? [r.id] : []));
  return payload.op === "update"
    ? { updatedIds: okIds, okCount, errors }
    : { deletedIds: okIds, okCount, errors };
};
