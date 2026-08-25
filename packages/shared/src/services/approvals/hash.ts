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
      collectionId: payload.collectionId,
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

/**
 * Dedup key for a STAGED load, whose rows never reach this process in one piece
 * — so, unlike {@link recordWriteLookupHash}, it cannot hash them. It hashes
 * the load's description plus a `rowsDigest` the caller computed over the rows
 * it is about to send.
 *
 * The digest keeps the key honest: without it, "200 000 rows into clients"
 * would match ANY other 200 000-row load into the same type, and a re-run with
 * corrected data would silently replay the old outcome instead of importing.
 * It is computed SDK-side over canonicalized rows, which is also what makes the
 * re-run contract affordable: the client can tell "this is the same load" for
 * the price of one local hash, without uploading a byte.
 *
 * Dedup only — tenancy stays on the JWT, and the human grant stays required.
 */
export const recordImportLookupHash = (input: {
  op: string;
  collectionId: string;
  totalRows: number;
  rowsDigest: string;
}): string => canonicalHash({ kind: "record_import", ...input });
