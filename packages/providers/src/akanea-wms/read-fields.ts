/**
 * The filterable vocabulary of each Xtent entity — the names a `filters` or
 * `sorts` string may use, beside the snake_case names the Python models
 * return.
 *
 * Why this exists. `guidance.md` documents every WRITE field exhaustively and
 * left reads to examples, so a caller mapped the model's snake_case onto
 * PascalCase and guessed. The mapping is irregular often enough that guessing
 * fails: `order_reference` is `Order`, `su_available` is `SUAvaillable` (the
 * vendor spells "available" with a double L), `client_name` is the nested
 * `Client.Name`. Xtent answers a wrong name with a WCF fault carried in an
 * HTTP 200 — "No property or field 'OrderReference' exists in type
 * 'EnPreparation'" — which costs a round trip and a licence-seat lease each
 * time. Measured over 2026-09-15..22: 35 of 237 Akanea calls failed, 23 of
 * them on a name or a type the caller had no way to look up.
 *
 * `type` is what XTENT holds, which is NOT always what the Python model
 * returns: `client_code_id` comes back as a string (codes are written as
 * strings everywhere in the write payloads) while Xtent types the column
 * `Int64`. Quoting it — `ClientCodeId="10024"`, the natural thing to do after
 * reading the payload examples — yields "Operator '=' incompatible with
 * operand types 'Int64' and 'String'". That single trap accounted for 9 of
 * the 35 failures, so the generated skill prints the type next to every name.
 *
 * This table is the SOURCE: `scripts/generate-sdk.ts` renders it into the
 * generated `SKILL.md`, and `tests/unit/akanea-wms-read-fields.test.ts` holds
 * it against the mappers in `handlers.ts` so the two cannot drift.
 */

/**
 * Render the tables into the generated SKILL.md.
 *
 * Appended after `guidance.md` rather than written into it: the names and
 * types come from the mappers, so a hand-maintained copy is the exact thing
 * this table exists to prevent.
 */
export const renderAkaneaReadFieldTables = (): string => {
  const sections = AKANEA_READ_ENTITIES.map((entity) => {
    const rows = entity.fields.map(
      (f) =>
        `| \`${f.python}\` | \`${f.xtent}\` | ${f.type} | ${f.note ?? ""} |`,
    );
    return [
      `### ${entity.entity} — ${entity.actions.join(", ")}`,
      "",
      ...(entity.caveat ? [entity.caveat, ""] : []),
      "| python | filter on | type | |",
      "| --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  });

  return [
    "## Filterable properties",
    "",
    "`filters` and `sorts` name the XTENT property, which is not the Python key and not always its PascalCase — `order_reference` filters as `Order`, `client_name` as the nested `Client.Name`. A name Xtent does not know comes back as a fault in an HTTP 200, after a round trip and a licence-seat lease; there is no partial match and no suggestion, so read the name off this table rather than deriving it.",
    "",
    "**Quote by TYPE, not by how the value looks.** `String` takes double quotes, `Int64` takes none — `ClientCodeId=10024`, never `ClientCodeId=\"10024\"`, even though the same code is written as a STRING in every write payload. Quoting an `Int64` fails with \"Operator '=' incompatible with operand types 'Int64' and 'String'\".",
    "",
    ...sections,
  ].join("\n");
};

/** How Xtent types a column — decides whether a filter value takes quotes. */
export type AkaneaFieldType = "Int64" | "String" | "DateTime" | "Boolean";

export interface AkaneaReadField {
  /** The key on the Python model. */
  python: string;
  /** The property a `filters` / `sorts` string must name. */
  xtent: string;
  type: AkaneaFieldType;
  /** Only when the name alone misleads. */
  note?: string;
}

export interface AkaneaReadEntity {
  /** The type name Xtent puts in its fault messages. */
  entity: string;
  /** The SDK reads that resolve against this entity. */
  actions: string[];
  fields: AkaneaReadField[];
  /** Stated before the table when the read's shape is not the entity's. */
  caveat?: string;
}

export const AKANEA_READ_ENTITIES: AkaneaReadEntity[] = [
  {
    entity: "EnItemQuantities",
    actions: ["get_item_quantities"],
    fields: [
      { python: "item_code", xtent: "ItemCode", type: "String" },
      { python: "client_code_id", xtent: "ClientCodeId", type: "Int64" },
      {
        python: "client_name",
        xtent: "Client.Name",
        type: "String",
        note: "nested — the warehouse customer, not a flat column",
      },
      { python: "batch_number", xtent: "BatchNumber", type: "String" },
      { python: "pallet", xtent: "Pallet", type: "String" },
      { python: "warehouse_id", xtent: "WarehouseId", type: "String" },
      {
        python: "status_id",
        xtent: "Status.Id",
        type: "String",
        note: "nested — this entity has no flat StatusId",
      },
      { python: "expiry_date", xtent: "ExpiryDate", type: "DateTime" },
      { python: "fifo_date", xtent: "FIFODate", type: "DateTime" },
      {
        python: "su_available",
        xtent: "SUAvaillable",
        type: "Int64",
        note: "double L, spelled that way by Xtent",
      },
      { python: "su_real_stock", xtent: "SURealStock", type: "Int64" },
      { python: "su_reserved", xtent: "SUReserved", type: "Int64" },
      { python: "su_blocked", xtent: "SUBlocked", type: "Int64" },
      { python: "su_stored", xtent: "SUStored", type: "Int64" },
      {
        python: "parcels_available",
        xtent: "ParcelsAvaillable",
        type: "Int64",
        note: "double L",
      },
      {
        python: "parcels_real_stock",
        xtent: "ParcelsRealStock",
        type: "Int64",
      },
      {
        python: "full_pallets_available",
        xtent: "FullPalletsAvaillable",
        type: "Int64",
        note: "double L",
      },
      {
        python: "full_pallets_real_stock",
        xtent: "FullPalletsRealStock",
        type: "Int64",
      },
      { python: "gross_weight", xtent: "GrossWeight", type: "Int64" },
      { python: "net_weight", xtent: "NetWeight", type: "Int64" },
    ],
  },
  {
    entity: "EnStockMovements",
    actions: ["list_stock_movements"],
    fields: [
      { python: "id", xtent: "Id", type: "Int64" },
      { python: "item_code", xtent: "ItemCode", type: "String" },
      { python: "client_code_id", xtent: "ClientCodeId", type: "Int64" },
      { python: "client_name", xtent: "Client.Name", type: "String" },
      { python: "movement_code", xtent: "MovementCode", type: "String" },
      { python: "movement_type", xtent: "MovementType", type: "String" },
      {
        python: "movement_date",
        xtent: "StockDate",
        type: "DateTime",
        note: "the column is StockDate, NOT MovementDate",
      },
      { python: "creation_date", xtent: "CreationDate", type: "DateTime" },
      { python: "batch_number", xtent: "BatchNumber", type: "String" },
      { python: "pallet_number", xtent: "PalletNumber", type: "String" },
      { python: "location_id", xtent: "LocationId", type: "String" },
      { python: "status_id", xtent: "StatusId", type: "String" },
      { python: "sales_unit", xtent: "SalesUnit", type: "Int64" },
      { python: "unit_qty", xtent: "UnitQty", type: "Int64" },
      { python: "parcels", xtent: "Parcels", type: "Int64" },
      { python: "full_pallets", xtent: "FullPallets", type: "Int64" },
      { python: "reception_id", xtent: "ReceptionId", type: "Int64" },
      { python: "preparation_id", xtent: "PreparationId", type: "Int64" },
    ],
  },
  {
    entity: "EnReception",
    actions: ["list_receptions", "list_receptions_stored"],
    caveat:
      '`list_receptions_stored` RETURNS one row per stock object, but FILTERS against the reception header below — a line field like `ItemCode` is not a property of `EnReception`. To select headers by their content, test the collection: `EdiReceptionDetailsList.Count(ItemCode="AAA-01")>=1`.',
    fields: [
      { python: "id", xtent: "Id", type: "Int64" },
      { python: "client_code_id", xtent: "ClientCodeId", type: "Int64" },
      {
        python: "order_reference",
        xtent: "Order",
        type: "String",
        note: "the column is Order, NOT OrderReference",
      },
      { python: "movement_code_id", xtent: "MovementCodeId", type: "String" },
      { python: "order_status", xtent: "OrderStatus", type: "String" },
      { python: "supplier_name", xtent: "SupplierName", type: "String" },
      {
        python: "supplier_reference",
        xtent: "SupplierReference",
        type: "String",
      },
      { python: "carrier_name", xtent: "CarrierName", type: "String" },
      {
        python: "planned_receiving_date",
        xtent: "DateOfPlannedReceiving",
        type: "DateTime",
      },
      {
        python: "actual_receiving_date",
        xtent: "DateOfActualReceiving",
        type: "DateTime",
      },
      {
        python: "appointment_date",
        xtent: "AppointmentDate",
        type: "DateTime",
      },
      { python: "arrival_date", xtent: "ArrivalDate", type: "DateTime" },
      {
        python: "reception_warehouse_id",
        xtent: "ReceptionWarehouseId",
        type: "String",
      },
      { python: "truck_number", xtent: "TruckNumber", type: "String" },
      { python: "number_of_pallets", xtent: "NumberOfPallets", type: "Int64" },
      { python: "number_of_parcels", xtent: "NumberOfParcels", type: "Int64" },
      { python: "number_of_sale_units", xtent: "NumberOfSU", type: "Int64" },
      { python: "creation_date", xtent: "CreationDate", type: "DateTime" },
      { python: "validation_date", xtent: "ValidationDate", type: "DateTime" },
    ],
  },
  {
    entity: "EnPreparation",
    actions: [
      "list_preparations",
      "list_preparations_prepared",
      "list_preparations_sscc",
    ],
    caveat:
      "`list_preparations_prepared` and `list_preparations_sscc` RETURN one row per stock object, but FILTER against the preparation header below — `ItemCode`, `BatchNumber` and `PreparationId` are not properties of `EnPreparation`. There is no readable `consignee_code_id`: Xtent publishes the consignee only by name and address, although `consignee_code_id` is REQUIRED when writing one.",
    fields: [
      { python: "id", xtent: "Id", type: "Int64" },
      { python: "client_code_id", xtent: "ClientCodeId", type: "Int64" },
      {
        python: "order_reference",
        xtent: "Order",
        type: "String",
        note: "the column is Order, NOT OrderReference",
      },
      { python: "client_reference", xtent: "ClientReference", type: "String" },
      {
        python: "consignee_reference",
        xtent: "ConsigneeReference",
        type: "String",
      },
      { python: "order_status", xtent: "OrderStatus", type: "String" },
      { python: "consignee_name", xtent: "ConsigneeName", type: "String" },
      {
        python: "consignee_city_name",
        xtent: "ConsigneeCityName",
        type: "String",
      },
      {
        python: "consignee_country_id",
        xtent: "ConsigneeCountryId",
        type: "String",
      },
      { python: "carrier_name", xtent: "CarrierName", type: "String" },
      {
        python: "planned_delivery_date",
        xtent: "PlannedDeliveryDate",
        type: "DateTime",
      },
      {
        python: "imperative_delivery_date",
        xtent: "ImperativeDeliveryDate",
        type: "DateTime",
      },
      {
        python: "planned_preparation_date",
        xtent: "PlannedPreparationDate",
        type: "DateTime",
      },
      {
        python: "actual_preparation_date",
        xtent: "ActualPreparationDate",
        type: "DateTime",
      },
      {
        python: "preparation_warehouse_id",
        xtent: "PreparationWarehouseId",
        type: "String",
      },
      {
        python: "urgency_code",
        xtent: "Emergency.Id",
        type: "String",
        note: "nested",
      },
      { python: "creation_date", xtent: "CreationDate", type: "DateTime" },
      { python: "validation_date", xtent: "ValidationDate", type: "DateTime" },
    ],
  },
  {
    entity: "EnItem",
    actions: ["list_items"],
    caveat:
      "There is no party entity to query: `EnParty` does not answer a read, so `Code` / `CodeId` / `ClientName` are not filterable anywhere. An item is how a warehouse customer is resolved — filter an item code, read `client_code_id` and `client_name` off the row.",
    fields: [
      { python: "id", xtent: "Id", type: "Int64" },
      { python: "item_code", xtent: "ItemCode", type: "String" },
      {
        python: "client_code_id",
        xtent: "Client.Id",
        type: "Int64",
        note: "nested here — NOT the flat ClientCodeId the other entities use",
      },
      {
        python: "client_name",
        xtent: "Client.Name",
        type: "String",
        note: "nested — NOT ClientName",
      },
      { python: "description", xtent: "Description", type: "String" },
      {
        python: "external_reference",
        xtent: "ExternalReference",
        type: "String",
      },
      {
        python: "family_code",
        xtent: "Family.Id",
        type: "String",
        note: "nested",
      },
      { python: "unit_code", xtent: "Unit.Id", type: "String", note: "nested" },
      {
        python: "supplier_code_id",
        xtent: "Supplier.Id",
        type: "Int64",
        note: "nested",
      },
      {
        python: "supplier_name",
        xtent: "Supplier.Name",
        type: "String",
        note: "nested",
      },
      { python: "batch_management", xtent: "BatchManagement", type: "String" },
      { python: "available", xtent: "Available", type: "Boolean" },
      { python: "inner", xtent: "Inner", type: "Int64" },
      { python: "outer", xtent: "Outer", type: "Int64" },
      { python: "layers_per_pallet", xtent: "LayersPerPallet", type: "Int64" },
      { python: "parcels_per_layer", xtent: "ParcelsPerLayer", type: "Int64" },
      {
        python: "parcel_gross_weight",
        xtent: "ParcelGrossWeight",
        type: "Int64",
      },
      { python: "parcel_net_weight", xtent: "ParcelNetWeight", type: "Int64" },
    ],
  },
];
