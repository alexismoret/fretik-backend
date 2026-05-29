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
    typeof (raw as { url: unknown }).url === "string"
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
 * Flatten a Shipment row from the Shiptify API into the manifest's
 * `Shipment` shape. Two normalisations:
 *  - `shipment_mode` arrives as `{id, name}` (the lookup row) but the
 *    manifest declares a `string`; we expose the `name` so the agent
 *    reads `s.shipment_mode === "Air"` without a sub-object dereference.
 *  - Top-level Pydantic ignores unknown keys (carrier, address_from,
 *    address_dest, booker, contents, …) — no rewrite needed for those.
 */
const flattenShipment = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) {
    return raw as Record<string, unknown>;
  }
  const row = raw;
  const mode = row.shipment_mode;
  if (isRecord(mode) && typeof mode.name === "string") {
    return { ...row, shipment_mode: mode.name };
  }
  return row;
};

const shipmentList = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.map(flattenShipment) : raw;

/**
 * Galaxy (carrier-side) shipment normalisation. Same `shipment_mode`
 * flatten as `flattenShipment`, plus a `shipper: {id, name}` flatten —
 * Galaxy responses often nest the shipper row instead of exposing just
 * `shipper_id`. We project `shipper.name` into a top-level
 * `shipper_name` so the agent reads it without sub-object navigation
 * and keep the original `shipper_id` (the manifest's `GalaxyShipment`
 * type already declares it). Unknown keys are passed through.
 */
const flattenGalaxyShipment = (raw: unknown): Record<string, unknown> => {
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

const galaxyShipmentList = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.map(flattenGalaxyShipment) : raw;

/**
 * Galaxy shipment-request normalisation — flattens nested
 * `shipper: {id, name}` and `shipment_mode: {id, name}` the same way
 * the shipper-side request mapper does. Used by
 * `galaxy_list_carrier_shipment_requests`, `galaxy_list_ready_to_book`,
 * and any future single-SR getter.
 */
const flattenGalaxyShipmentRequest = (
  raw: unknown,
): Record<string, unknown> => {
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

const galaxyShipmentRequestList = (raw: unknown): unknown =>
  Array.isArray(raw) ? raw.map(flattenGalaxyShipmentRequest) : raw;

export const shiptifyMappers: ProviderMappers = {
  request: {
    sanitiseCreateShipmentRequest,
  },
  response: {
    attachmentDownload,
    shipment: flattenShipment,
    shipmentList,
    galaxyShipment: flattenGalaxyShipment,
    galaxyShipmentList,
    galaxyShipmentRequest: flattenGalaxyShipmentRequest,
    galaxyShipmentRequestList,
  },
};
