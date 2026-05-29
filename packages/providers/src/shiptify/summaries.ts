import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Shiptify approval-card summary builders. One entry per write action.
 *
 * Rule (per `ADDING_A_PROVIDER.md`): surface only fields a non-technical
 * user can sanity-check on their own — booking name, free-text comments,
 * dates, message bodies, counts. Skip raw integer ids: a `shipment_id:
 * 1234567` row is noise. The card title carries the action verb; the
 * fields carry the human-readable substance.
 */

/**
 * Coerce a JSON-ish arg value into a display string, or `null` if the
 * value is missing / empty / not a primitive. The dispatcher hands us
 * `Record<string, unknown>` so we accept primitives and otherwise drop
 * the field — never produce a `[object Object]` row in the approval card.
 */
const asDisplayString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  return null;
};

const truncate = (s: string, n = 240): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`;

const optionalField = (
  labelKey: string,
  value: unknown,
  kind?: "html",
): OperationSummaryPart["fields"][number] | null => {
  const stringValue = asDisplayString(value);
  if (stringValue === null) return null;
  return kind === "html"
    ? { labelKey, value: stringValue, kind }
    : { labelKey, value: stringValue };
};

const compact = (
  ...items: (OperationSummaryPart["fields"][number] | null)[]
): OperationSummaryPart["fields"] =>
  items.filter((i): i is OperationSummaryPart["fields"][number] => i !== null);

// ── Shipment requests ────────────────────────────────────────────────

const createShipmentRequest: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: asDisplayString(args.name) ?? "" },
  fields: compact(
    optionalField("name", args.name),
    optionalField("reply_before", args.reply_before),
    optionalField("comment", args.comment),
    optionalField("internal_ref", args.internal_ref),
    optionalField("internal_name", args.internal_name),
    {
      labelKey: "from_count",
      value: Array.isArray(args.from_addresses)
        ? args.from_addresses.length.toString()
        : "0",
    },
    {
      labelKey: "dest_count",
      value: Array.isArray(args.dest_addresses)
        ? args.dest_addresses.length.toString()
        : "0",
    },
  ),
});

const createShipmentRequestDraft: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: asDisplayString(args.name) ?? "" },
  fields: compact(
    optionalField("name", args.name),
    optionalField("internal_ref", args.internal_ref),
    optionalField("comment", args.comment),
  ),
});

const updateShipmentRequest: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(
    optionalField("name", args.name),
    optionalField("comment", args.comment),
    optionalField("internal_ref", args.internal_ref),
    optionalField("internal_name", args.internal_name),
  ),
});

const cancelShipmentRequest: SummaryMapper = () => ({
  titleKey: "default",
  titleParams: {},
  fields: [],
});

const uploadShipmentRequestAttachment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {
    count: Array.isArray(args.attachments) ? args.attachments.length : 0,
  },
  fields: compact({
    labelKey: "attachment_count",
    value: Array.isArray(args.attachments)
      ? args.attachments.length.toString()
      : "0",
  }),
});

const sendShipmentRequestMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact({
    labelKey: "message",
    value: truncate(asDisplayString(args.message) ?? ""),
  }),
});

// ── Shipments ────────────────────────────────────────────────────────

const confirmShipmentPickup: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("incident", args.incident),
    optionalField("comment", args.comment),
  ),
});

const confirmShipmentDelivery: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("incident", args.incident),
    optionalField("comment", args.comment),
  ),
});

const replanShipmentPickup: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("reason", args.reason),
    optionalField("comment", args.comment),
  ),
});

const replanShipmentDelivery: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("reason", args.reason),
    optionalField("comment", args.comment),
  ),
});

const uploadShipmentAttachment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {
    count: Array.isArray(args.attachments) ? args.attachments.length : 0,
  },
  fields: compact({
    labelKey: "attachment_count",
    value: Array.isArray(args.attachments)
      ? args.attachments.length.toString()
      : "0",
  }),
});

const sendShipmentMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact({
    labelKey: "message",
    value: truncate(asDisplayString(args.message) ?? ""),
  }),
});

// ── Locations ────────────────────────────────────────────────────────

const createLocation: SummaryMapper = (args) => {
  const cityCountry = compact(
    optionalField("city", args.city),
    optionalField("country", args.country),
  );
  return {
    titleKey: "default",
    titleParams: { name: asDisplayString(args.name) ?? "" },
    fields: compact(
      optionalField("name", args.name),
      optionalField("address_1", args.address_1),
      optionalField("address_2", args.address_2),
      optionalField("zipcode", args.zipcode),
      ...cityCountry,
      optionalField("recipient_name", args.recipient_name),
      optionalField("internal_ref", args.internal_ref),
      optionalField("instructions", args.instructions),
    ),
  };
};

// ── Galaxy (carrier-side) summaries ──────────────────────────────────
//
// Same construction rules as the shipper-side summaries: human-readable
// fields only, no raw ids beyond the resource being acted on. Most
// summaries mirror the shipper ones because the payloads largely match
// — the role split lives in the URL + manifest, not in the user-facing
// approval card. Where Galaxy adds a field the shipper version lacks
// (e.g. `shipper_id` on create), we surface it sparingly.

const galaxyCreateCarrierShipmentRequest: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: asDisplayString(args.name) ?? "" },
  fields: compact(
    optionalField("name", args.name),
    optionalField("reply_before", args.reply_before),
    optionalField("comment", args.comment),
    optionalField("internal_ref", args.internal_ref),
    optionalField("other_reference", args.other_reference),
    {
      labelKey: "from_count",
      value: Array.isArray(args.from_addresses)
        ? args.from_addresses.length.toString()
        : "0",
    },
    {
      labelKey: "dest_count",
      value: Array.isArray(args.dest_addresses)
        ? args.dest_addresses.length.toString()
        : "0",
    },
  ),
});

const galaxyCreateCarrierShipmentRequestDraft: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: asDisplayString(args.name) ?? "" },
  fields: compact(
    optionalField("name", args.name),
    optionalField("internal_ref", args.internal_ref),
    optionalField("comment", args.comment),
  ),
});

const galaxyUploadShipmentRequestAttachment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {
    count: Array.isArray(args.attachments) ? args.attachments.length : 0,
  },
  fields: compact({
    labelKey: "attachment_count",
    value: Array.isArray(args.attachments)
      ? args.attachments.length.toString()
      : "0",
  }),
});

const galaxySendShipmentRequestMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact({
    labelKey: "message",
    value: truncate(asDisplayString(args.message) ?? ""),
  }),
});

const galaxyCancelQuoteRequest: SummaryMapper = () => ({
  titleKey: "default",
  titleParams: {},
  fields: [],
});

const galaxyConfirmShipmentPickup: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("incident", args.incident),
    optionalField("comment", args.comment),
  ),
});

const galaxyConfirmShipmentDelivery: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("incident", args.incident),
    optionalField("comment", args.comment),
  ),
});

const galaxyReplanShipmentPickup: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("reason", args.reason),
    optionalField("comment", args.comment),
  ),
});

const galaxyReplanShipmentDelivery: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("reason", args.reason),
    optionalField("comment", args.comment),
  ),
});

const galaxyConfirmShipment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
  ),
});

const galaxyCancelShipment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(optionalField("comment", args.comment)),
});

const galaxyUploadShipmentAttachment: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {
    count: Array.isArray(args.attachments) ? args.attachments.length : 0,
  },
  fields: compact({
    labelKey: "attachment_count",
    value: Array.isArray(args.attachments)
      ? args.attachments.length.toString()
      : "0",
  }),
});

const galaxySendShipmentMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact({
    labelKey: "message",
    value: truncate(asDisplayString(args.message) ?? ""),
  }),
});

const galaxyConfirmTrackingPoint: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("incident", args.incident),
    optionalField("comment", args.comment),
  ),
});

const galaxyReplanTrackingPoint: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { date: asDisplayString(args.date) ?? "" },
  fields: compact(
    optionalField("date", args.date),
    optionalField("time", args.time),
    optionalField("reason", args.reason),
    optionalField("comment", args.comment),
  ),
});

const galaxyCancelTrackingPoint: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(optionalField("comment", args.comment)),
});

const galaxyUpdateTrackingPointLocation: SummaryMapper = () => ({
  // The address_id and tracking_point_id are raw ids — drop them from
  // the card per the no-id rule. The verb-only title is enough for the
  // user to spot the intent and approve / reject.
  titleKey: "default",
  titleParams: {},
  fields: [],
});

export const shiptifySummaries: ProviderSummaries = {
  // Shipper-side
  create_shipment_request: createShipmentRequest,
  create_shipment_request_draft: createShipmentRequestDraft,
  update_shipment_request: updateShipmentRequest,
  cancel_shipment_request: cancelShipmentRequest,
  upload_shipment_request_attachment: uploadShipmentRequestAttachment,
  send_shipment_request_message: sendShipmentRequestMessage,
  confirm_shipment_pickup: confirmShipmentPickup,
  confirm_shipment_delivery: confirmShipmentDelivery,
  replan_shipment_pickup: replanShipmentPickup,
  replan_shipment_delivery: replanShipmentDelivery,
  upload_shipment_attachment: uploadShipmentAttachment,
  send_shipment_message: sendShipmentMessage,
  create_location: createLocation,
  // Galaxy (carrier-side)
  galaxy_create_carrier_shipment_request: galaxyCreateCarrierShipmentRequest,
  galaxy_create_carrier_shipment_request_draft:
    galaxyCreateCarrierShipmentRequestDraft,
  galaxy_upload_shipment_request_attachment:
    galaxyUploadShipmentRequestAttachment,
  galaxy_send_shipment_request_message: galaxySendShipmentRequestMessage,
  galaxy_cancel_quote_request: galaxyCancelQuoteRequest,
  galaxy_confirm_shipment_pickup: galaxyConfirmShipmentPickup,
  galaxy_confirm_shipment_delivery: galaxyConfirmShipmentDelivery,
  galaxy_replan_shipment_pickup: galaxyReplanShipmentPickup,
  galaxy_replan_shipment_delivery: galaxyReplanShipmentDelivery,
  galaxy_confirm_shipment: galaxyConfirmShipment,
  galaxy_cancel_shipment: galaxyCancelShipment,
  galaxy_upload_shipment_attachment: galaxyUploadShipmentAttachment,
  galaxy_send_shipment_message: galaxySendShipmentMessage,
  galaxy_confirm_tracking_point: galaxyConfirmTrackingPoint,
  galaxy_replan_tracking_point: galaxyReplanTrackingPoint,
  galaxy_cancel_tracking_point: galaxyCancelTrackingPoint,
  galaxy_update_tracking_point_location: galaxyUpdateTrackingPointLocation,
};
