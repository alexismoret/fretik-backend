import {
  arr,
  asNumber,
  asString,
  bool,
  isRecord,
  num,
  prop,
  str,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";
import { HUMAN_REFERENCE_FIELDS } from "./invariants";

/**
 * Approval cards for Pbyp's write actions.
 *
 * The bar every row here has to clear: could the person approving spot a
 * mistake from it alone? A `folder_id: 4127` cannot be checked by anyone —
 * a folder number, a container number, a party name and a date can. So the
 * cards carry references and human values, and leave the primary keys out
 * unless the id IS the only thing being said (an unshare, a detach).
 *
 * Labels are i18n keys resolved at render time, never French or English
 * strings: the card is shown in the approver's language, which is not
 * necessarily the language of the conversation.
 */

type Field = OperationSummaryPart["fields"][number];

const asDisplayString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  return null;
};

const truncate = (s: string, n = 200): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`;

const field = (labelKey: string, value: unknown): Field | null => {
  const display = asDisplayString(value);
  return display === null ? null : { labelKey, value: truncate(display) };
};

const compact = (...items: (Field | null)[]): Field[] =>
  items.filter((item): item is Field => item !== null);

const count = (labelKey: string, value: unknown): Field | null => {
  const list = arr(value);
  return list.length === 0 ? null : { labelKey, value: list.length.toString() };
};

/**
 * A party as the card should read it: the name when the agent is creating
 * the address, otherwise the id it is reusing.
 */
const party = (labelKey: string, value: unknown): Field | null => {
  if (!isRecord(value)) return field(labelKey, value);
  const name = asString(value.name);
  if (name !== undefined) {
    const city = asString(value.city);
    return { labelKey, value: city === undefined ? name : `${name}, ${city}` };
  }
  const id = asNumber(value.id);
  return id === undefined ? null : { labelKey, value: `#${id.toString()}` };
};

/** `orders` → the i18n key for "Orders", so the card names a thing. */
const collectionLabel = (collection: string): Field => ({
  labelKey: "collection",
  value: collection,
});

/**
 * The reference a reader recognises, pulled out of the payload itself when
 * it carries one — `number` on an order, `folder_number` on a folder. A
 * generic write has no typed shape, so this is the only chance to say what
 * the row IS rather than where it lives.
 */
const humanReference = (
  collection: string,
  row: Record<string, unknown>,
): Field | null => {
  const key = HUMAN_REFERENCE_FIELDS[collection];
  if (key === undefined) return null;
  return field("reference", row[key]);
};

/**
 * Changed columns as `name: value` rows, nested structures summarised
 * rather than dumped: a card is read, not parsed.
 */
const changedFields = (data: Record<string, unknown>): Field[] =>
  Object.entries(data)
    .slice(0, 12)
    .map(([key, value]): Field => {
      if (Array.isArray(value)) {
        return { labelKey: key, value: `${value.length.toString()} ×` };
      }
      if (isRecord(value)) {
        const name = asString(value.name) ?? asString(value.id);
        return { labelKey: key, value: name ?? "…" };
      }
      return { labelKey: key, value: truncate(asDisplayString(value) ?? "—") };
    });

// ── Generic writes ────────────────────────────────────────────────────

const createItems: SummaryMapper = (args) => {
  const collection = str(args.collection);
  const items = arr(args.items);
  const first = items[0];
  return {
    titleKey: "default",
    titleParams: { count: items.length, collection },
    fields: compact(
      collectionLabel(collection),
      { labelKey: "row_count", value: items.length.toString() },
      isRecord(first) ? humanReference(collection, first) : null,
      ...(items.length === 1 && isRecord(first) ? changedFields(first) : []),
    ),
  };
};

const updateItems: SummaryMapper = (args) => {
  const collection = str(args.collection);
  const ids = arr(args.ids);
  const data = isRecord(args.data) ? args.data : {};
  return {
    titleKey: "default",
    titleParams: { count: ids.length, collection },
    fields: compact(
      collectionLabel(collection),
      { labelKey: "ids", value: truncate(ids.join(", ")) },
      ...changedFields(data),
    ),
  };
};

const deleteItems: SummaryMapper = (args) => {
  const collection = str(args.collection);
  const ids = arr(args.ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length, collection },
    fields: compact(collectionLabel(collection), {
      labelKey: "ids",
      value: truncate(ids.join(", ")),
    }),
  };
};

// ── Typed writes ──────────────────────────────────────────────────────

const createOrder: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { number: str(args.number) },
  fields: compact(
    field("number", args.number),
    field("module", args.module),
    field("date", args.date),
    field("incoterm", args.incoterm),
    party("shipper", args.shipper),
    party("consignee", args.consignee),
    field("client_reference", args.client_reference),
    count("parcels", args.parcels),
    count("shared_with", args.shared_with),
    field("comments", args.comments),
  ),
});

const createFolder: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { module: str(args.module), type: str(args.folder_type) },
  fields: compact(
    field("module", args.module),
    field("folder_type", args.folder_type),
    field("date", args.date),
    field("incoterm", args.incoterm),
    party("shipper", args.shipper),
    party("consignee", args.consignee),
    field("master_id", args.master_id),
    count("order_ids", args.order_ids),
    count("parcels", args.parcels),
  ),
});

const createSeaBooking: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { number: str(args.booking_number) },
  fields: compact(
    field("booking_number", args.booking_number),
    field("ship_name", args.ship_name),
    field("voyage_number", args.voyage_number),
    field("BL_number", args.BL_number),
    field("ETD", args.ETD),
    field("ETA", args.ETA),
    count("containers", args.containers),
  ),
});

const createAirBooking: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { number: str(args.booking_number) },
  fields: compact(
    field("booking_number", args.booking_number),
    field("LTA", args.LTA),
    count("flights", args.flights),
  ),
});

const createQuotation: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { number: str(args.number) },
  fields: compact(
    field("number", args.number),
    field("module", args.transport_type),
    field("incoterm", args.incoterm),
    field("validity_end_date", args.validity_end_date),
    count("quotes", args.quotes),
    count("parcels", args.parcels),
  ),
});

const addEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { target: str(args.target_type) },
  fields: compact(
    field("target", `${str(args.target_type)} #${str(args.target_id)}`),
    field("event_type_id", args.event_type_id),
    field("date", args.date),
    field("actual", args.actual),
    field("comments", args.comments),
  ),
});

const setParcels: SummaryMapper = (args) => {
  const parcels = arr(args.parcels);
  const quantity = parcels.reduce<number>(
    (total, parcel) => total + num(prop(parcel, "quantity")),
    0,
  );
  return {
    titleKey: "default",
    titleParams: { target: str(args.target_type) },
    fields: compact(
      field("target", `${str(args.target_type)} #${str(args.target_id)}`),
      { labelKey: "line_count", value: parcels.length.toString() },
      { labelKey: "total_quantity", value: quantity.toString() },
    ),
  };
};

const attachOrderToFolder: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(
    field("module", args.module),
    field("order_id", args.order_id),
    field("folder_id", args.folder_id),
  ),
});

const shareWithEntity: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { entity_id: num(args.entity_id) },
  fields: compact(
    field("object", `${str(args.object)} #${str(args.object_id)}`),
    field("entity_id", args.entity_id),
    {
      labelKey: "access",
      value: bool(args.can_edit) ? "edit" : "read",
    },
  ),
});

const revokeShare: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { entity_id: num(args.entity_id) },
  fields: compact(
    field("object", `${str(args.object)} #${str(args.object_id)}`),
    field("entity_id", args.entity_id),
  ),
});

const archiveObject: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { object: str(args.object) },
  fields: compact(
    field("object", str(args.object)),
    field("object_id", args.object_id),
  ),
});

const setQuotationStatus: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { status: str(args.quotation_status) },
  fields: compact(
    field("quotation_id", args.quotation_id),
    field("quotation_status", args.quotation_status),
  ),
});

/**
 * The card that matters most: enrolling an object in a gateway is what puts
 * it in front of an outside company, and nothing downstream asks again.
 */
const transferToGateway: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { object: str(args.object) },
  fields: compact(
    field("object", `${str(args.object)} #${str(args.object_id)}`),
    field("gateway_id", args.gateway_id),
    field("external_reference", args.external_reference),
  ),
});

const assignContainers: SummaryMapper = (args) => {
  const items = arr(args.items);
  const containers = new Set<number>();
  for (const item of items) {
    const direct = asNumber(prop(item, "container_id"));
    if (direct !== undefined) containers.add(direct);
    for (const parcel of arr(prop(item, "parcels"))) {
      const id = asNumber(prop(parcel, "container_id"));
      if (id !== undefined) containers.add(id);
    }
  }
  return {
    titleKey: "default",
    titleParams: { count: items.length },
    fields: compact(
      field("scope", args.scope),
      { labelKey: "row_count", value: items.length.toString() },
      { labelKey: "container_count", value: containers.size.toString() },
    ),
  };
};

const unassignParcelContainer: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(
    field("scope", args.scope),
    field("target_id", args.target_id),
    field("parcel_id", args.parcel_id),
  ),
});

const activateProfile: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { profile_id: num(args.profile_id) },
  fields: compact(field("profile_id", args.profile_id)),
});

const createGateway: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { code: str(args.external_code) },
  fields: compact(
    field("external_code", args.external_code),
    field("gateway_type", args.gateway_type),
    field("entity_id", args.entity_id),
  ),
});

const updateGateway: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { code: str(args.external_code) },
  fields: compact(
    field("gateway_id", args.gateway_id),
    field("external_code", args.external_code),
    field("gateway_type", args.gateway_type),
  ),
});

const declareTracking: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(
    field("module", args.module),
    field("booking_id", args.booking_id),
  ),
});

const createLtaStock: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {},
  fields: compact(
    field("first_awb", args.first_awb),
    field("last_awb", args.last_awb),
    field("airline_company", args.airline_company),
    field("entity_id", args.entity_id),
  ),
});

const inviteUser: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { email: str(args.email) },
  fields: compact(
    field("name", `${str(args.first_name)} ${str(args.last_name)}`.trim()),
    field("email", args.email),
    field("entity_id", args.entity_id),
    field("role_id", args.role_id),
  ),
});

const createClient: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.name) },
  fields: compact(
    field("name", args.name),
    field("agency_id", args.agency_id),
    field("admin_email", prop(args.admin_user, "email")),
    party("address", args.address),
  ),
});

export const pbypSummaries: ProviderSummaries = {
  create_items: createItems,
  update_items: updateItems,
  delete_items: deleteItems,
  create_order: createOrder,
  create_folder: createFolder,
  create_sea_booking: createSeaBooking,
  create_air_booking: createAirBooking,
  create_quotation: createQuotation,
  add_event: addEvent,
  set_parcels: setParcels,
  attach_order_to_folder: attachOrderToFolder,
  detach_order_from_folder: attachOrderToFolder,
  share_with_entity: shareWithEntity,
  revoke_share: revokeShare,
  archive: archiveObject,
  set_quotation_status: setQuotationStatus,
  transfer_to_gateway: transferToGateway,
  assign_containers: assignContainers,
  unassign_parcel_container: unassignParcelContainer,
  activate_profile: activateProfile,
  create_gateway: createGateway,
  update_gateway: updateGateway,
  declare_tracking: declareTracking,
  create_lta_stock: createLtaStock,
  invite_user: inviteUser,
  create_client: createClient,
};
