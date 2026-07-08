import type { ToolApprovalRecordWritePayload } from "../../db/schema";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical JSON: keys sorted at every level, `undefined` dropped. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) sorted[key] = canonical(v);
    }
    return sorted;
  }
  return value;
};

/**
 * Deterministic sha256 over a canonicalized value (keys sorted, `undefined`
 * dropped) — the dedup-key primitive shared by every hashed approval kind. A
 * re-run that builds the same value produces the same key and matches its
 * consumed grant (cache replay, no double-execute).
 */
export const canonicalHash = (value: unknown): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(canonical(value)));
  return hasher.digest("hex");
};

/**
 * Dedup key for a gated `record_write` — hashed over the STABLE write intent
 * only (display metadata such as labels, type name/icon, and current snapshots
 * are excluded, so a relabelled record still matches). Mirrors the plan
 * `lookupHash` so a Python re-run of the same bulk call replays the cache
 * instead of writing twice.
 */
export const recordWriteLookupHash = (
  payload: ToolApprovalRecordWritePayload,
): string => {
  if (payload.op === "create") {
    return canonicalHash({
      op: "create",
      objectTypeId: payload.objectTypeId,
      rows: payload.items.map((i) => ({
        data: i.data,
        relations: i.relations,
      })),
    });
  }
  if (payload.op === "update") {
    return canonicalHash({
      op: "update",
      merge: payload.merge ?? false,
      updates: payload.items.map((i) => ({
        recordId: i.recordId,
        data: i.data,
      })),
    });
  }
  return canonicalHash({
    op: "delete",
    recordIds: payload.items.map((i) => i.recordId),
  });
};
