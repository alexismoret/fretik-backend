import { arr, isRecord } from "@fretik/shared/external-apps/json-access";
import type { ParamSpec } from "@fretik/shared/external-apps/manifest-schema";
import { boolToOn } from "./normalize";

/**
 * Curated EDI payload tables — the single source of truth for what the
 * agent may send to Xtent's `IntegrationWebServices/*` endpoints.
 *
 * Two constraints shape this file:
 *
 *  1. `validateActionArgs` compiles nested `object` specs to a plain Zod
 *     object, so any key we do NOT declare here is stripped before the
 *     handler ever sees it. A permissive "pass whatever you like" payload
 *     is therefore impossible — every usable field must be declared.
 *  2. Our convention is snake_case; Xtent's wire format is PascalCase
 *     (`ClientCodeId`), with a few names that read like typos but are the
 *     real contract (`ExpectedSaleUnit` singular, `listPartys`).
 *
 * Declaring each entity once as an ordered table and deriving BOTH the
 * manifest `ParamSpec` fields and the outgoing wire body from it keeps the
 * two in sync — a field added below is instantly accepted, validated, and
 * transmitted.
 *
 * The subsets are intentionally partial: Xtent's entities carry 100+
 * columns each (customs, excise, accounting, 10 free-text slots, …). What
 * is declared here is what a logistics team asks a generalist assistant
 * for; the rest stays out so the SKILL and the approval cards stay
 * readable. Adding a field is a one-line change.
 */

export interface WireField {
  /** snake_case name the agent uses. */
  key: string;
  /** PascalCase name Xtent expects on the wire. */
  wire: string;
  spec: ParamSpec;
  /** Nested table — set for `object` fields and arrays of objects. */
  children?: readonly WireField[];
  /**
   * Sibling key to copy when this one is omitted. Xtent marks a few
   * fields mandatory that duplicate another one (their own examples send
   * the item code as the "internal item id"), so we fill them rather than
   * make the agent repeat itself.
   */
  fallbackFrom?: string;
}

export const toParamFields = (
  table: readonly WireField[],
): Record<string, ParamSpec> => {
  const fields: Record<string, ParamSpec> = {};
  for (const entry of table) {
    fields[entry.key] = entry.spec;
  }
  return fields;
};

const convert = (entry: WireField, value: unknown): unknown => {
  if (entry.children !== undefined) {
    if (entry.spec.type === "array") {
      return arr(value)
        .filter(isRecord)
        .map((row) => toWire(entry.children ?? [], row));
    }
    return isRecord(value) ? toWire(entry.children, value) : undefined;
  }
  if (entry.spec.type === "boolean") {
    return boolToOn(value) ?? value;
  }
  return value;
};

/** Project agent args onto the PascalCase body Xtent expects. */
export const toWire = (
  table: readonly WireField[],
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const entry of table) {
    const raw =
      value[entry.key] ??
      (entry.fallbackFrom !== undefined
        ? value[entry.fallbackFrom]
        : undefined);
    if (raw === undefined || raw === null) continue;
    const converted = convert(entry, raw);
    if (converted === undefined) continue;
    body[entry.wire] = converted;
  }
  return body;
};

/** Build the array-of-entity spec for a nested lines list. */
const lines = (
  table: readonly WireField[],
  description: string,
): ParamSpec => ({
  type: "array",
  description,
  items: { type: "object", fields: toParamFields(table) },
});

// ── Shared field shapes ──────────────────────────────────────────────

const code = (description: string, optional = true): ParamSpec => ({
  type: "string",
  optional,
  description,
});

const date = (description: string): ParamSpec => ({
  type: "string",
  optional: true,
  description,
});

const qty = (description: string, optional = true): ParamSpec => ({
  type: "number",
  optional,
  description,
});

const freeText = (description: string): ParamSpec => ({
  type: "string",
  optional: true,
  excludeFromHash: true,
  description,
});

// ── Receptions (inbound) ─────────────────────────────────────────────

export const receptionLineFields: readonly WireField[] = [
  {
    key: "line_number",
    wire: "LineNumber",
    spec: { type: "integer", description: "Line number, 1-based" },
  },
  {
    key: "item_code",
    wire: "ItemCode",
    spec: {
      type: "string",
      description: "Item code as known by the warehouse",
    },
  },
  {
    key: "expected_sale_units",
    wire: "ExpectedSaleUnit",
    spec: qty("Expected quantity in sale units (UVC)", false),
  },
  {
    key: "internal_item_id",
    wire: "InternalItemId",
    fallbackFrom: "item_code",
    spec: code("Xtent internal item id; defaults to item_code when omitted"),
  },
  {
    key: "batch_number",
    wire: "BatchNumber",
    spec: code("Batch / lot number"),
  },
  { key: "expiry_date", wire: "ExpiryDate", spec: date("Best-before date") },
  {
    key: "expected_parcels",
    wire: "ExpectedParcel",
    spec: qty("Expected number of parcels"),
  },
  {
    key: "expected_full_pallets",
    wire: "ExpectedFullPallet",
    spec: qty("Expected number of full pallets"),
  },
  { key: "gross_weight", wire: "GrossWeight", spec: qty("Gross weight") },
  { key: "net_weight", wire: "NetWeight", spec: qty("Net weight") },
  {
    key: "status_code_id",
    wire: "StatusCodeId",
    spec: code("Stock status code applied to the line"),
  },
  {
    key: "external_line_number",
    wire: "ExternalLineNumber",
    spec: { type: "integer", optional: true, description: "Caller's line ref" },
  },
  { key: "comments", wire: "Comments", spec: freeText("Free-text line note") },
];

export const receptionFields: readonly WireField[] = [
  {
    key: "client_code_id",
    wire: "ClientCodeId",
    spec: code("Warehouse-customer (stockeur) code — REQUIRED", false),
  },
  {
    key: "movement_code_id",
    wire: "MovementCodeId",
    spec: code("Movement code configured for this flow — REQUIRED", false),
  },
  {
    key: "lines",
    wire: "EdiReceptionDetailsList",
    children: receptionLineFields,
    spec: lines(receptionLineFields, "Reception lines — at least one"),
  },
  {
    key: "id",
    wire: "Id",
    spec: {
      type: "integer",
      optional: true,
      description: "Xtent internal movement number — set it to UPDATE",
    },
  },
  {
    key: "order_reference",
    wire: "Order",
    spec: code("Purchase-order reference"),
  },
  { key: "supplier_code_id", wire: "SupplierCodeId", spec: code("Supplier") },
  { key: "supplier_name", wire: "SupplierName", spec: code("Supplier name") },
  {
    key: "supplier_reference",
    wire: "SupplierReference",
    spec: code("Supplier's own reference"),
  },
  { key: "carrier_code_id", wire: "CarrierCodeId", spec: code("Carrier code") },
  { key: "carrier_name", wire: "CarrierName", spec: code("Carrier name") },
  {
    key: "planned_receiving_date",
    wire: "DateOfPlannedReceiving",
    spec: date("Planned receiving date"),
  },
  {
    key: "appointment_date",
    wire: "AppointmentDate",
    spec: date("Booked dock slot"),
  },
  { key: "arrival_date", wire: "ArrivalDate", spec: date("Actual arrival") },
  {
    key: "reception_warehouse_id",
    wire: "ReceptionWarehouseId",
    spec: code("Receiving warehouse / depot code"),
  },
  { key: "office_id", wire: "OfficeId", spec: code("Branch code") },
  { key: "truck_number", wire: "TruckNumber", spec: code("Truck plate") },
  {
    key: "container_number",
    wire: "ContainersNumber",
    spec: code("Container number"),
  },
  { key: "seal", wire: "Seal", spec: code("Seal number") },
  {
    key: "number_of_pallets",
    wire: "NumberOfPallets",
    spec: qty("Announced pallet count"),
  },
  {
    key: "number_of_parcels",
    wire: "NumberOfParcels",
    spec: qty("Announced parcel count"),
  },
  {
    key: "comments",
    wire: "Comments",
    spec: freeText("Free-text note (80 chars)"),
  },
];

// ── Preparations (outbound picking orders) ───────────────────────────

export const preparationLineFields: readonly WireField[] = [
  {
    key: "line_number",
    wire: "LineNumber",
    spec: { type: "integer", description: "Line number, 1-based" },
  },
  {
    key: "item_code",
    wire: "ItemCode",
    spec: {
      type: "string",
      description: "Item code as known by the warehouse",
    },
  },
  {
    key: "ordered_sale_units",
    wire: "OrderedSaleUnits",
    spec: qty("Ordered quantity in sale units (UVC)", false),
  },
  {
    key: "internal_item_id",
    wire: "InternalItemId",
    fallbackFrom: "item_code",
    spec: code("Xtent internal item id; defaults to item_code when omitted"),
  },
  {
    key: "batch_number",
    wire: "BatchNumber",
    spec: code("Batch / lot number"),
  },
  {
    key: "ordered_parcels",
    wire: "OrderedParcels",
    spec: qty("Ordered parcels"),
  },
  {
    key: "ordered_full_pallets",
    wire: "OrderedFullPallets",
    spec: qty("Ordered full pallets"),
  },
  { key: "expiry_date", wire: "ExpiryDate", spec: date("Best-before date") },
  {
    key: "status_code_id",
    wire: "StatusCodeId",
    spec: code("Stock status the goods must be picked from"),
  },
  {
    key: "external_line_number",
    wire: "ExternalLineNumber",
    spec: { type: "integer", optional: true, description: "Caller's line ref" },
  },
  { key: "comments", wire: "Comments", spec: freeText("Free-text line note") },
];

/**
 * Header comments of a preparation. Xtent types them rather than offering one
 * free-text box: a note meant for the picker, the carrier or the delivery slip
 * lands in a different place in the warehouse, so the TYPE is mandatory and
 * carries the routing. Capped at 3 by the vendor (`0-3`), one per type in
 * practice.
 */
export const preparationCommentFields: readonly WireField[] = [
  {
    key: "comment_type",
    wire: "CommentType",
    spec: {
      type: "string",
      description:
        "Where the note goes: PRE preparation, TRS transport, LIV delivery slip, REC reception",
    },
  },
  {
    key: "comment",
    wire: "Comment",
    spec: freeText("The note itself, 512 characters max"),
  },
  {
    key: "order",
    wire: "Order",
    spec: { type: "integer", optional: true, description: "Display rank" },
  },
];

export const preparationFields: readonly WireField[] = [
  {
    key: "client_code_id",
    wire: "ClientCodeId",
    spec: code("Warehouse-customer (stockeur) code — REQUIRED", false),
  },
  {
    key: "consignee_code_id",
    wire: "ConsigneeCodeId",
    spec: code("Consignee (ship-to party) code — REQUIRED", false),
  },
  {
    key: "lines",
    wire: "EdiPreparationDetailsList",
    children: preparationLineFields,
    spec: lines(preparationLineFields, "Preparation lines — at least one"),
  },
  {
    key: "comments",
    wire: "EdiPreparationCommentsList",
    children: preparationCommentFields,
    spec: lines(
      preparationCommentFields,
      "Header notes, up to 3, each typed by where it must appear",
    ),
  },
  {
    key: "id",
    wire: "Id",
    spec: {
      type: "integer",
      optional: true,
      description: "Xtent internal movement number — set it to UPDATE",
    },
  },
  {
    key: "order_reference",
    wire: "Order",
    spec: code("Sales-order reference"),
  },
  {
    key: "client_reference",
    wire: "ClientReference",
    spec: code("Warehouse customer's own reference"),
  },
  {
    key: "consignee_reference",
    wire: "ConsigneeReference",
    spec: code("Consignee's own reference"),
  },
  { key: "consignee_name", wire: "ConsigneeName", spec: code("Ship-to name") },
  {
    key: "consignee_address1",
    wire: "ConsigneeAddress1",
    spec: code("Ship-to address line 1"),
  },
  {
    key: "consignee_address2",
    wire: "ConsigneeAddress2",
    spec: code("Ship-to address line 2"),
  },
  {
    key: "consignee_zip_code",
    wire: "ConsigneeZipCode",
    spec: code("Ship-to postcode"),
  },
  {
    key: "consignee_city_name",
    wire: "ConsigneeCityName",
    spec: code("Ship-to city"),
  },
  {
    key: "consignee_country_id",
    wire: "ConsigneeCountryId",
    spec: code("Ship-to country code (FR, BE, …)"),
  },
  { key: "contact_name", wire: "ContactName", spec: code("Delivery contact") },
  { key: "contact_phone", wire: "ContactPhone", spec: code("Contact phone") },
  { key: "contact_mail", wire: "ContactMail", spec: code("Contact email") },
  { key: "carrier_code_id", wire: "CarrierCodeId", spec: code("Carrier code") },
  { key: "carrier_name", wire: "CarrierName", spec: code("Carrier name") },
  {
    key: "planned_delivery_date",
    wire: "PlannedDeliveryDate",
    spec: date("Planned delivery date"),
  },
  {
    key: "imperative_delivery_date",
    wire: "ImperativeDeliveryDate",
    spec: date("Hard delivery deadline"),
  },
  {
    key: "planned_preparation_date",
    wire: "PlannedPreparationDate",
    spec: date("Planned picking date"),
  },
  {
    key: "preparation_warehouse_id",
    wire: "PreparationWarehouseId",
    spec: code("Picking warehouse / depot code"),
  },
  {
    key: "movement_code_id",
    wire: "MovementCodeId",
    spec: code("Movement code configured for this flow"),
  },
  { key: "office_id", wire: "OfficeId", spec: code("Branch code") },
  {
    key: "urgent",
    wire: "Urgent",
    spec: { type: "boolean", optional: true, description: "Flag as urgent" },
  },
];

// ── Items (article master data) ──────────────────────────────────────

export const priorityRackFields: readonly WireField[] = [
  {
    key: "warehouse_id",
    wire: "WarehouseId",
    spec: { type: "string", description: "Warehouse / depot code" },
  },
  {
    key: "movement_type",
    wire: "MovementType",
    spec: {
      type: "enum",
      values: ["ENT", "SOR", "TRA", "RET", "KIT"],
      description:
        "ENT reception, SOR preparation, TRA transfer, RET return, KIT kit",
    },
  },
  {
    key: "priority_rack",
    wire: "PriorityRack",
    spec: code("Preferred rack code"),
  },
  {
    key: "priority",
    wire: "Priority",
    spec: { type: "integer", optional: true, description: "Ordering weight" },
  },
];

export const itemFields: readonly WireField[] = [
  {
    key: "client_code_id",
    wire: "ClientCodeId",
    spec: code("Warehouse-customer (stockeur) code — REQUIRED", false),
  },
  {
    key: "item_code",
    wire: "ItemCode",
    spec: { type: "string", description: "Item code — REQUIRED" },
  },
  {
    key: "description",
    wire: "Description",
    spec: { type: "string", description: "Item label — REQUIRED" },
  },
  {
    key: "priority_racks",
    wire: "EdiItemPriorityRack",
    children: priorityRackFields,
    spec: lines(
      priorityRackFields,
      "Storage rules per warehouse and movement type — at least one",
    ),
  },
  {
    key: "external_reference",
    wire: "ExternalReference",
    spec: code("Caller's own item reference"),
  },
  { key: "family_code", wire: "FamilyCode", spec: code("Item family code") },
  {
    key: "packaging_code",
    wire: "PackagingCode",
    spec: code("Packaging code"),
  },
  { key: "unit_code", wire: "UnitCode", spec: code("Unit code") },
  {
    key: "supplier_code_id",
    wire: "SupplierCodeId",
    spec: code("Default supplier code"),
  },
  {
    key: "batch_management",
    wire: "BatchManagement",
    spec: {
      type: "enum",
      values: ["L", "I"],
      optional: true,
      description: "L free batch entry, I batch imposed; omit for none",
    },
  },
  {
    key: "available",
    wire: "Available",
    spec: { type: "boolean", optional: true, description: "Item is active" },
  },
  {
    key: "inner",
    wire: "Inner",
    spec: qty("Sale units per inner pack (SPCB)"),
  },
  { key: "outer", wire: "Outer", spec: qty("Sale units per parcel (PCB)") },
  {
    key: "layers_per_pallet",
    wire: "LayersPerPallet",
    spec: qty("Layers per pallet"),
  },
  {
    key: "parcels_per_layer",
    wire: "ParcelsPerLayer",
    spec: qty("Parcels per layer"),
  },
  {
    key: "parcel_gross_weight",
    wire: "ParcelGrossWeight",
    spec: qty("Gross weight of one parcel"),
  },
  {
    key: "parcel_net_weight",
    wire: "ParcelNetWeight",
    spec: qty("Net weight of one parcel"),
  },
  {
    key: "comments",
    wire: "Comments",
    spec: freeText("Free-text note (80 chars)"),
  },
];

// ── Parties (third parties: suppliers, consignees, carriers) ─────────

export const partyFields: readonly WireField[] = [
  {
    key: "id",
    wire: "Id",
    spec: { type: "string", description: "Party code — REQUIRED" },
  },
  { key: "name", wire: "Name", spec: code("Legal / trading name") },
  {
    key: "party_category",
    wire: "WarehousePartyCategory",
    spec: {
      type: "enum",
      values: ["F", "D", "S", "T"],
      optional: true,
      description: "F supplier, D consignee, S warehouse customer, T carrier",
    },
  },
  { key: "office_id", wire: "OfficeId", spec: code("Branch code") },
  { key: "address1", wire: "Address1", spec: code("Address line 1") },
  { key: "address2", wire: "Address2", spec: code("Address line 2") },
  { key: "zip_code", wire: "ZipCode", spec: code("Postcode") },
  { key: "city_name", wire: "CityName", spec: code("City") },
  { key: "country_id", wire: "CountryId", spec: code("Country code") },
  {
    key: "operation_address1",
    wire: "OperationAddress1",
    spec: code("Operating site address line 1"),
  },
  {
    key: "operation_address2",
    wire: "OperationAddress2",
    spec: code("Operating site address line 2"),
  },
  {
    key: "operation_zip_code",
    wire: "OperationZipCode",
    spec: code("Operating site postcode"),
  },
  {
    key: "operation_city_name",
    wire: "OperationCityName",
    spec: code("Operating site city"),
  },
  {
    key: "operation_country_id",
    wire: "OperationCountryId",
    spec: code("Operating site country code"),
  },
  { key: "email", wire: "Email", spec: code("Contact email") },
  { key: "phone_number", wire: "PhoneNumber", spec: code("Phone") },
  { key: "siret", wire: "Siret", spec: code("SIRET number") },
  {
    key: "vat_identification",
    wire: "VatIdentification",
    spec: code("VAT number"),
  },
  { key: "eori_number", wire: "EORINumber", spec: code("EORI number") },
  {
    key: "available",
    wire: "Available",
    spec: { type: "boolean", optional: true, description: "Party is active" },
  },
];

// ── Stock changes ────────────────────────────────────────────────────

export const stockChangeFields: readonly WireField[] = [
  {
    key: "client_code_id",
    wire: "ClientCodeId",
    spec: code("Warehouse-customer (stockeur) code"),
  },
  { key: "item_code", wire: "ItemCode", spec: code("Item code") },
  { key: "item_id", wire: "ItemId", spec: code("Xtent internal item id") },
  {
    key: "pallet_number",
    wire: "PalletNumber",
    spec: code("Pallet number identifying the stock object"),
  },
  {
    key: "batch_number",
    wire: "BatchNumber",
    spec: code("Batch / lot number"),
  },
  {
    key: "location_id",
    wire: "LocationId",
    spec: code("Target storage location id"),
  },
  { key: "movement_code", wire: "MovementCode", spec: code("Movement code") },
  {
    key: "movement_type",
    wire: "MovementType",
    spec: {
      type: "enum",
      values: ["ENT", "SOR", "TRA", "RET", "KIT"],
      optional: true,
      description:
        "ENT reception, SOR preparation, TRA transfer, RET return, KIT kit",
    },
  },
  { key: "movement_date", wire: "MovementDate", spec: date("Movement date") },
  { key: "unit_qty", wire: "UnitQty", spec: qty("Unit quantity") },
  { key: "sales_unit", wire: "SalesUnit", spec: qty("Quantity in sale units") },
  { key: "parcels", wire: "Parcels", spec: qty("Parcel count") },
  { key: "full_pallets", wire: "FullPallets", spec: qty("Full-pallet count") },
  { key: "status_id", wire: "StatusId", spec: code("Stock status code") },
  { key: "expiry_date", wire: "ExpiryDate", spec: date("Best-before date") },
  { key: "fifo_date", wire: "FIFODate", spec: date("FIFO date") },
  {
    key: "instruction_type",
    wire: "InstructionType",
    spec: code("Instruction type"),
  },
  {
    key: "instruction_date",
    wire: "InstructionDate",
    spec: date("Instruction date"),
  },
  {
    key: "stock_modification_label",
    wire: "StockModificationLabel",
    spec: freeText("Reason shown in the stock history"),
  },
];
