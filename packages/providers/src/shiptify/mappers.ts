import { isRecord } from "@fretik/shared/external-apps/json-access";
import type {
  ProviderMappers,
  RequestMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Shiptify request + response mappers. Most actions pass through
 * `buildRequest()` + `fetch()` untouched; the few mappers here either
 * reshape a raw API response into the manifest's `returns` shape, or
 * sanitise an outgoing payload before it hits Shiptify.
 */

// ── Request mappers ──────────────────────────────────────────────────

/**
 * Strip a trailing timezone suffix from `reply_before` on any
 * `create_shipment_request*` action. Shiptify's spec is strict on the
 * format `YYYY-MM-DDTHH:MM:SS` (no timezone) — the manifest description
 * tells the agent, but Pydantic accepts `+02:00` upstream of us, so
 * this one-liner saves a wasted network round-trip.
 *
 * No-op when `reply_before` is absent (draft variants). Other args pass
 * through untouched.
 */
const sanitiseCreateShipmentRequest: RequestMapper = (args) => {
  const out: Record<string, unknown> = { ...args };
  if (typeof out.reply_before === "string") {
    out.reply_before = out.reply_before.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  }
  return { body: out };
};

// ── Response mappers ─────────────────────────────────────────────────

/**
 * `GET /attachments/{id}/download` returns a plain string body — the
 * signed URL. We wrap it in `{ url }` so it matches the manifest's
 * `AttachmentDownload` type and the generated Python SDK exposes
 * `result.url` instead of an awkward bare-string.
 */
const attachmentDownload = (raw: unknown): { url: string } => {
  if (typeof raw === "string") return { url: raw };
  if (
    raw !== null &&
    typeof raw === "object" &&
    "url" in raw &&
    typeof raw.url === "string"
  ) {
    return { url: (raw as { url: string }).url };
  }
  // Defensive: surface a clear error rather than a silent {} that breaks
  // the SDK's Pydantic parse.
  throw new Error(
    `attachmentDownload: unexpected response shape (${typeof raw})`,
  );
};

/**
 * Flatten a shipment row into the manifest's `Shipment` shape. Used by
 * BOTH roles: `/shipments/*` and `/galaxy*` return the same 46 fields for
 * the same shipment, so they share one mapper as they share one type.
 *
 * Two normalisations:
 *  - `shipment_mode` arrives as `{id, name}` (the lookup row) but the
 *    manifest declares a `string`; we expose the `name` so the agent
 *    reads `s.shipment_mode == "Air"` without a sub-object dereference.
 *  - `shipper` is nested as `{id, name}`; we project `shipper.name` into
 *    a top-level `shipper_name` and backfill `shipper_id` when the row
 *    only carried the nested one.
 *
 * Everything else passes through — Pydantic drops the keys the type does
 * not declare (carrier, address_from, address_dest, booker, contents, …).
 */
const flattenShipment = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) {
    return raw as Record<string, unknown>;
  }
  const row = raw;
  const out: Record<string, unknown> = { ...row };
  const mode = row.shipment_mode;
  if (isRecord(mode) && typeof mode.name === "string") {
    out.shipment_mode = mode.name;
  }
  const shipper = row.shipper;
  if (isRecord(shipper)) {
    if (typeof shipper.name === "string") out.shipper_name = shipper.name;
    if (typeof shipper.id === "number" && out.shipper_id === undefined) {
      out.shipper_id = shipper.id;
    }
  }
  return out;
};

const shipmentList = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.map(flattenShipment) : raw;

/**
 * `/content-types` is the only content-type list both roles can read, and
 * it returns the FULL catalogue (~1 400 rows × 27 fields) with the four
 * dimensional fields as free text — `""` when unset, `"120"` when set.
 * The manifest declares them as numbers, so parse them here rather than
 * making every caller do it, and keep only the declared keys: the agent
 * filters this list in the sandbox, and two thirds of each row is weight
 * it never reads.
 */
const CONTENT_TYPE_KEYS = [
  "id",
  "name",
  "dimension_unit",
  "weight_unit",
  "is_container",
  "iso_container_type",
  "for_road",
  "for_sea",
  "for_air",
  "for_rail",
  "for_express",
  "for_groupage",
  "for_courier",
  "for_air_sea",
  "for_ro_ro",
  "for_river",
] as const;

const DIMENSION_KEYS = ["length", "width", "height", "weight"] as const;

/** `"120.5"` → 120.5; `""`, `null`, `"n/a"` → undefined (Pydantic `None`). */
const toNumberOrUndefined = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const trimContentType = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) {
    return raw as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_TYPE_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  for (const key of DIMENSION_KEYS) {
    const parsed = toNumberOrUndefined(raw[key]);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
};

const contentTypeList = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.map(trimContentType) : raw;

export const shiptifyMappers: ProviderMappers = {
  request: {
    sanitiseCreateShipmentRequest,
  },
  response: {
    attachmentDownload,
    shipment: flattenShipment,
    shipmentList,
    contentTypeList,
  },
};
