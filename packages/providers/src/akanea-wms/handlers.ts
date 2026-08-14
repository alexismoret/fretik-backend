import {
  arr,
  asString,
  isRecord,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderHandler,
  ProviderHandlerContext,
  ProviderHandlers,
} from "@fretik/shared/external-apps/provider-types";
import {
  AkaneaError,
  parseAkaneaConfig,
  unwrapResult,
  withToken,
  type AkaneaCall,
  type AkaneaConfig,
} from "./client";
import {
  boolField,
  compactRow,
  dateField,
  field,
  looseNumber,
  looseString,
  numField,
  relStrField,
  strField,
} from "./normalize";
import {
  itemFields,
  partyFields,
  preparationFields,
  receptionFields,
  stockChangeFields,
  toWire,
  type WireField,
} from "./payloads";

/**
 * One handler per manifest action. Each leases a license token, calls its
 * web service, and maps the reply onto the manifest's return type.
 *
 * Mapping is deliberately lenient — every field is read by name through
 * `normalize.ts` and dropped when absent, so a Xtent version that renames
 * or omits a column degrades to a missing value instead of a failed
 * action. The vendor documentation pins field NAMES but not the JSON
 * casing or the date format, and those differ between installs.
 */

/**
 * Header-only projections documented per endpoint — far lighter payloads, and
 * the reason receptions and preparations carry flat `ClientCodeId` columns
 * while `GetItems` and `GetItemQuantities` (which publish no such projection)
 * carry a nested `Client` object instead. Mappers must match the shape their
 * own request asks for; `relStrField` reads the nested one.
 */
const RECEPTION_HEADER_META = "79a55a90-3e2e-48a3-9058-20ed07b4e229";
const PREPARATION_HEADER_META = "67bafa0a-1c5c-4684-a189-f834a870a536";

const configOf = (ctx: ProviderHandlerContext): AkaneaConfig =>
  parseAkaneaConfig(ctx.credentials, ctx.connection_config);

/** Xtent's own examples send `filters` / `sorts` explicitly, null included. */
const queryBody = (
  args: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  filters: asString(args.filters) ?? null,
  sorts: asString(args.sorts) ?? null,
  ...extra,
});

/** A `1-*` payload may legitimately come back as a lone object. */
const asRows = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
};

const DEFAULT_LIMIT = 200;

/**
 * Cap what reaches the sandbox. Xtent's query services take no `top`, so a
 * loose filter can answer with the entire warehouse; truncating here keeps
 * one careless read from swallowing the turn.
 */
const capped = <T>(args: Record<string, unknown>, rows: T[]): T[] => {
  const limit = looseNumber(args.limit) ?? DEFAULT_LIMIT;
  return rows.length > limit ? rows.slice(0, limit) : rows;
};

const readRows = async (
  call: AkaneaCall,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> =>
  asRows(unwrapResult(await call(path, body)));

// ── Read mappers ─────────────────────────────────────────────────────

const toItemQuantity = (row: unknown): Record<string, unknown> =>
  compactRow({
    item_code: strField(row, "ItemCode"),
    client_code_id: strField(row, "ClientCodeId"),
    // The warehouse customer's NAME, the one thing no read used to expose. It
    // is what lets a caller tie a document to a `client_code_id` at all: the
    // code is internal to the WMS and never appears on a business document.
    client_name: relStrField(row, "Client", "Name"),
    batch_number: strField(row, "BatchNumber"),
    pallet: strField(row, "Pallet"),
    warehouse_id: strField(row, "WarehouseId"),
    // `EnItemQuantities` has no flat `StatusId` — the status is a relation.
    status_id: relStrField(row, "Status", "Id"),
    expiry_date: dateField(row, "ExpiryDate"),
    fifo_date: dateField(row, "FIFODate"),
    // Xtent spells the "available" columns with a double L.
    su_available: numField(row, "SUAvaillable"),
    su_real_stock: numField(row, "SURealStock"),
    su_reserved: numField(row, "SUReserved"),
    su_blocked: numField(row, "SUBlocked"),
    su_stored: numField(row, "SUStored"),
    parcels_available: numField(row, "ParcelsAvaillable"),
    parcels_real_stock: numField(row, "ParcelsRealStock"),
    full_pallets_available: numField(row, "FullPalletsAvaillable"),
    full_pallets_real_stock: numField(row, "FullPalletsRealStock"),
    gross_weight: numField(row, "GrossWeight"),
    net_weight: numField(row, "NetWeight"),
  });

const toStockMovement = (row: unknown): Record<string, unknown> =>
  compactRow({
    id: numField(row, "Id"),
    item_code: strField(row, "ItemCode"),
    client_code_id: strField(row, "ClientCodeId"),
    client_name: relStrField(row, "Client", "Name"),
    movement_code: strField(row, "MovementCode"),
    movement_type: strField(row, "MovementType"),
    // `StockDate` ("Date stock"), not `MovementDate` — the latter is not a
    // field of `EnStockMovements` under any projection, so this read was
    // always empty.
    movement_date: dateField(row, "StockDate"),
    creation_date: dateField(row, "CreationDate"),
    batch_number: strField(row, "BatchNumber"),
    pallet_number: strField(row, "PalletNumber"),
    location_id: strField(row, "LocationId"),
    status_id: strField(row, "StatusId"),
    sales_unit: numField(row, "SalesUnit"),
    unit_qty: numField(row, "UnitQty"),
    parcels: numField(row, "Parcels"),
    full_pallets: numField(row, "FullPallets"),
    reception_id: numField(row, "ReceptionId"),
    preparation_id: numField(row, "PreparationId"),
  });

const toReception = (row: unknown): Record<string, unknown> =>
  compactRow({
    id: numField(row, "Id"),
    client_code_id: strField(row, "ClientCodeId"),
    order_reference: strField(row, "Order"),
    movement_code_id: strField(row, "MovementCodeId"),
    // Header reads expose `StatusReception`; the EDI payload calls the same
    // enum `OrderStatus`.
    order_status:
      strField(row, "OrderStatus") ?? strField(row, "StatusReception"),
    supplier_name: strField(row, "SupplierName"),
    supplier_reference: strField(row, "SupplierReference"),
    carrier_name: strField(row, "CarrierName"),
    planned_receiving_date: dateField(row, "DateOfPlannedReceiving"),
    actual_receiving_date: dateField(row, "DateOfActualReceiving"),
    appointment_date: dateField(row, "AppointmentDate"),
    arrival_date: dateField(row, "ArrivalDate"),
    reception_warehouse_id: strField(row, "ReceptionWarehouseId"),
    truck_number: strField(row, "TruckNumber"),
    // No `NumberOfLines` on `EnReception` under either projection — only the
    // three totals below. Count `list_receptions_stored` rows for a line count.
    number_of_pallets: numField(row, "NumberOfPallets"),
    number_of_parcels: numField(row, "NumberOfParcels"),
    number_of_sale_units: numField(row, "NumberOfSU"),
    creation_date: dateField(row, "CreationDate"),
    validation_date: dateField(row, "ValidationDate"),
  });

const toPreparation = (row: unknown): Record<string, unknown> =>
  compactRow({
    id: numField(row, "Id"),
    client_code_id: strField(row, "ClientCodeId"),
    order_reference: strField(row, "Order"),
    client_reference: strField(row, "ClientReference"),
    consignee_reference: strField(row, "ConsigneeReference"),
    order_status: strField(row, "OrderStatus"),
    consignee_name: strField(row, "ConsigneeName"),
    consignee_city_name: strField(row, "ConsigneeCityName"),
    consignee_country_id: strField(row, "ConsigneeCountryId"),
    carrier_name: strField(row, "CarrierName"),
    planned_delivery_date: dateField(row, "PlannedDeliveryDate"),
    imperative_delivery_date: dateField(row, "ImperativeDeliveryDate"),
    planned_preparation_date: dateField(row, "PlannedPreparationDate"),
    actual_preparation_date: dateField(row, "ActualPreparationDate"),
    preparation_warehouse_id: strField(row, "PreparationWarehouseId"),
    // `Urgent` is not a field of `EnPreparation`; urgency is the `Emergency`
    // relation, hence a CODE rather than the boolean this used to promise (and
    // never deliver). Preparations also carry none of the `NumberOf*` totals
    // that receptions do — count `list_preparations_prepared` rows instead.
    urgency_code: relStrField(row, "Emergency", "Id"),
    creation_date: dateField(row, "CreationDate"),
    validation_date: dateField(row, "ValidationDate"),
  });

const toItem = (row: unknown): Record<string, unknown> =>
  compactRow({
    id: numField(row, "Id"),
    item_code: strField(row, "ItemCode"),
    // `GetItems` publishes NO header projection, so every one of these is a
    // nested relation on `EnItem` and never a flat `*CodeId` column. Reading
    // the flat names here returned `undefined` on all five, which is what sent
    // an agent hunting through the WMS for a warehouse customer the item
    // already carried. `PackagingCode` is gone outright: `EnItem` has no such
    // field under any shape.
    client_code_id: relStrField(row, "Client", "Id"),
    client_name: relStrField(row, "Client", "Name"),
    description: strField(row, "Description"),
    external_reference: strField(row, "ExternalReference"),
    family_code: relStrField(row, "Family", "Id"),
    unit_code: relStrField(row, "Unit", "Id"),
    supplier_code_id: relStrField(row, "Supplier", "Id"),
    supplier_name: relStrField(row, "Supplier", "Name"),
    batch_management: strField(row, "BatchManagement"),
    available: boolField(row, "Available"),
    inner: numField(row, "Inner"),
    outer: numField(row, "Outer"),
    layers_per_pallet: numField(row, "LayersPerPallet"),
    parcels_per_layer: numField(row, "ParcelsPerLayer"),
    parcel_gross_weight: numField(row, "ParcelGrossWeight"),
    parcel_net_weight: numField(row, "ParcelNetWeight"),
  });

/**
 * The stock objects a reception/preparation carries once the floor has
 * acted on it. Documented as `StocksList`; matched loosely so a renamed
 * collection still resolves.
 */
const STOCK_COLLECTION_KEYS = ["stockslist", "stocklist", "stocks"];

const stockObjectsOf = (row: Record<string, unknown>): unknown[] => {
  const documented = field(row, "StocksList");
  if (Array.isArray(documented)) return documented;
  // Exact alternatives only: a substring match would bind a neighbouring
  // `StockMovementsList` and make the result depend on key order.
  for (const [key, value] of Object.entries(row)) {
    if (
      Array.isArray(value) &&
      STOCK_COLLECTION_KEYS.includes(key.toLowerCase())
    ) {
      return value;
    }
  }
  return [];
};

const toStockLine = (
  parentKey: "reception_id" | "preparation_id",
  parentId: number | undefined,
  stock: unknown,
): Record<string, unknown> =>
  compactRow({
    [parentKey]: parentId,
    item_code: strField(stock, "ItemCode"),
    batch_number: strField(stock, "BatchNumber"),
    pallet_number: strField(stock, "PalletNumber"),
    location_id: strField(stock, "LocationId"),
    status_id: strField(stock, "StatusId"),
    sales_unit: numField(stock, "SalesUnit"),
    parcels: numField(stock, "Parcels"),
    full_pallets: numField(stock, "FullPallets"),
    gross_weight: numField(stock, "GrossWeight"),
    net_weight: numField(stock, "NetWeight"),
    expiry_date: dateField(stock, "ExpiryDate"),
    movement_date: dateField(stock, "MovementDate"),
  });

const flattenStockLines = (
  rows: Record<string, unknown>[],
  parentKey: "reception_id" | "preparation_id",
): Record<string, unknown>[] =>
  rows.flatMap((row) => {
    const parentId = numField(row, "Id");
    return stockObjectsOf(row).map((stock) =>
      toStockLine(parentKey, parentId, stock),
    );
  });

const toSsccLine = (
  preparationId: number | undefined,
  stock: unknown,
): Record<string, unknown> =>
  compactRow({
    preparation_id: preparationId,
    sscc: strField(stock, "SSCC"),
    pallet_number: strField(stock, "PalletNumber"),
    item_code: strField(stock, "ItemCode"),
    batch_number: strField(stock, "BatchNumber"),
    sales_unit: numField(stock, "SalesUnit"),
    parcels: numField(stock, "Parcels"),
  });

// ── Integration-result mapping ───────────────────────────────────────

/** Xtent echoes a different reference per entity family. */
const REFERENCE_KEYS = [
  "OrderReference",
  "SupplierReference",
  "ClientReference",
  "ConsigneeReference",
  "ItemCode",
  "Pallet",
];

/**
 * Per-entity result collections. The vendor documents four; the parties
 * ones are not documented at all, so both plausible spellings are probed —
 * without them an accepted `upsert_parties` would report zero acknowledged
 * entities and invite the agent to submit the same parties again.
 */
const RESULT_COLLECTIONS = [
  "ResultOfReceptionsIntegration",
  "ResultOfPreparationsIntegration",
  "ResultOfItemsIntegration",
  "ResultOfStockMovementsIntegration",
  "ResultOfPartiesIntegration",
  "ResultOfPartysIntegration",
];

/** Xtent ids echoed per entity family — the input `check_entity_integration` needs. */
const ENTITY_ID_KEYS = [
  "XtentReceptionId",
  "XtentPreparationId",
  "XtentItemId",
  "XtentPartyId",
];

/** Both spellings appear across the vendor's result envelopes. */
const errorStrings = (row: unknown): string[] =>
  [field(row, "Errors"), field(row, "ListOfErrors")].flatMap((value) =>
    arr(value)
      .map(
        (entry) => looseString(entry) ?? looseString(field(entry, "Message")),
      )
      .filter((entry): entry is string => entry !== undefined),
  );

const firstOf = (row: unknown, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = strField(row, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** Exported for tests — the write contract the agent verifies against. */
export const toIntegrationResult = (raw: unknown): Record<string, unknown> => {
  const result = unwrapResult(raw);

  // `FlowsId` is documented as a list of objects, but a deployment that
  // serialises bare ids must not silently yield zero flows — the whole
  // verify-later contract hangs off this value.
  const flowIds: number[] = [];
  for (const flow of arr(field(result, "FlowsId"))) {
    const id = numField(flow, "FlowID") ?? looseNumber(flow);
    if (id !== undefined) flowIds.push(id);
  }

  const references: string[] = [];
  const entityIds: number[] = [];
  const errors = errorStrings(result);
  let acceptedCount = 0;
  for (const collection of RESULT_COLLECTIONS) {
    for (const row of asRows(field(result, collection))) {
      const rowErrors = errorStrings(row);
      errors.push(...rowErrors);
      // A row carrying errors was NOT accepted — counting it would tell the
      // agent the write landed when part of it bounced.
      if (rowErrors.length === 0) acceptedCount += 1;
      const reference = firstOf(row, REFERENCE_KEYS);
      if (reference !== undefined) references.push(reference);
      const entityId = looseNumber(firstOf(row, ENTITY_ID_KEYS));
      if (entityId !== undefined) entityIds.push(entityId);
    }
  }

  return {
    flow_ids: flowIds,
    accepted_count: acceptedCount,
    entity_ids: entityIds,
    references,
    errors,
  };
};

// ── Read handlers ────────────────────────────────────────────────────

const getItemQuantities: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      (
        await readRows(
          call,
          "QueryWebServices/GetItemQuantities",
          queryBody(args),
        )
      ).map(toItemQuantity),
    ),
  );

const listStockMovements: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      (
        await readRows(
          call,
          "QueryWebServices/GetInternalStockMovements",
          queryBody(args),
        )
      ).map(toStockMovement),
    ),
  );

const listItems: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      (await readRows(call, "QueryWebServices/GetItems", queryBody(args))).map(
        toItem,
      ),
    ),
  );

const listReceptions: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      (
        await readRows(
          call,
          "QueryWebServices/GetReceptions",
          queryBody(args, { metaId: RECEPTION_HEADER_META }),
        )
      ).map(toReception),
    ),
  );

const listReceptionsStored: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      flattenStockLines(
        await readRows(
          call,
          "QueryWebServices/GetReceptions/Stored",
          queryBody(args),
        ),
        "reception_id",
      ),
    ),
  );

const listPreparations: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      (
        await readRows(
          call,
          "QueryWebServices/GetPreparations",
          // `metaId` is the key that applies — measured on a live install,
          // it cuts the payload from ~10 MB to ~2.3 MB. The `meta` spelling
          // from the vendor's own example is silently ignored.
          queryBody(args, { metaId: PREPARATION_HEADER_META }),
        )
      ).map(toPreparation),
    ),
  );

const listPreparationsPrepared: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) =>
    capped(
      args,
      flattenStockLines(
        await readRows(
          call,
          "QueryWebServices/GetPreparations/Prepared",
          queryBody(args),
        ),
        "preparation_id",
      ),
    ),
  );

const listPreparationsSscc: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) => {
    const rows = await readRows(
      call,
      "QueryWebServices/GetPreparations/SSCC",
      queryBody(args),
    );
    return capped(
      args,
      rows.flatMap((row) => {
        const preparationId = numField(row, "Id");
        return stockObjectsOf(row).map((stock) =>
          toSsccLine(preparationId, stock),
        );
      }),
    );
  });

const checkFlowStatus: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) => {
    const flowId = args.flow_id;
    const raw = await call("QueryWebServices/CheckFlowIntegrationStatus", {
      flowId,
    });
    const result = unwrapResult(raw);
    const errors = errorStrings(result);
    for (const collection of [
      "ListReceptionsInError",
      "ListPreparationsInError",
      "ListItemsInError",
    ]) {
      for (const row of asRows(field(result, collection))) {
        errors.push(...errorStrings(row));
      }
    }
    return compactRow({
      flow_id:
        numField(result, "FlowId") ??
        (typeof flowId === "number" ? flowId : undefined),
      flow_status: strField(result, "FlowStatus"),
      flow_type: strField(result, "FlowType"),
      non_integrated_count: numField(result, "NbrOfNonIntegratedEntities"),
      errors,
    });
  });

const checkEntityIntegration: ProviderHandler = async (args, ctx) =>
  withToken(configOf(ctx), async (call) => {
    const rows = await readRows(
      call,
      "QueryWebServices/CheckEntityIntegrationStatus",
      {
        typeEntities: args.entity_type,
        listOfEntitiesIds: arr(args.entity_ids),
      },
    );
    return rows.map((row) =>
      compactRow({
        entity_id: numField(row, "EntitieId"),
        status: strField(row, "EntitieStatus"),
        flow_id: numField(row, "FlowId"),
        errors: errorStrings(row),
      }),
    );
  });

// ── Write handlers ───────────────────────────────────────────────────

/**
 * Project the agent's rows onto the wire, refusing the empty payloads Xtent
 * would only reject asynchronously — `validateActionArgs` types the nested
 * lists as plain arrays, so `[]` passes schema validation and would come
 * back hours later as a failed flow.
 */
const wireRows = (
  args: Record<string, unknown>,
  key: string,
  table: readonly WireField[],
  label: string,
  requiredChild?: { key: string; wire: string; label: string },
): Record<string, unknown>[] => {
  const rows = arr(args[key])
    .filter(isRecord)
    .map((row) => toWire(table, row));
  if (rows.length === 0) {
    throw new AkaneaError(`No ${label} to send — \`${key}\` is empty.`);
  }
  if (requiredChild !== undefined) {
    rows.forEach((row, index) => {
      if (arr(row[requiredChild.wire]).length === 0) {
        throw new AkaneaError(
          `${label} ${(index + 1).toString()} has no ${requiredChild.label} — \`${requiredChild.key}\` needs at least one entry.`,
        );
      }
    });
  }
  return rows;
};

const integrate = async (
  ctx: ProviderHandlerContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  withToken(configOf(ctx), async (call) =>
    toIntegrationResult(await call(path, body)),
  );

const upsertReceptions: ProviderHandler = async (args, ctx) =>
  integrate(ctx, "IntegrationWebServices/Receptions", {
    listReceptions: wireRows(args, "receptions", receptionFields, "reception", {
      key: "lines",
      wire: "EdiReceptionDetailsList",
      label: "line",
    }),
  });

const upsertPreparations: ProviderHandler = async (args, ctx) =>
  integrate(ctx, "IntegrationWebServices/Preparations", {
    listPreparations: wireRows(
      args,
      "preparations",
      preparationFields,
      "preparation",
      { key: "lines", wire: "EdiPreparationDetailsList", label: "line" },
    ),
  });

const upsertItems: ProviderHandler = async (args, ctx) =>
  integrate(ctx, "IntegrationWebServices/Items", {
    listItems: wireRows(args, "items", itemFields, "item", {
      key: "priority_racks",
      wire: "EdiItemPriorityRack",
      label: "priority rack",
    }),
  });

const upsertParties: ProviderHandler = async (args, ctx) =>
  integrate(ctx, "IntegrationWebServices/Parties", {
    // `listPartys` is what Xtent's own runnable example posts; its parameter
    // table spells the same argument `listParties`. Only one key is sent:
    // on a create/update, a service that bound BOTH would duplicate every
    // party, and a wrong name fails loudly on the first call instead.
    listPartys: wireRows(args, "parties", partyFields, "party"),
  });

const changeStock: ProviderHandler = async (args, ctx) =>
  integrate(ctx, "IntegrationWebServices/StockChanges", {
    listStockModifications: wireRows(
      args,
      "stock_changes",
      stockChangeFields,
      "stock change",
    ),
  });

export const akaneaWmsHandlers: ProviderHandlers = {
  getItemQuantities,
  listStockMovements,
  listItems,
  listReceptions,
  listReceptionsStored,
  listPreparations,
  listPreparationsPrepared,
  listPreparationsSscc,
  checkFlowStatus,
  checkEntityIntegration,
  upsertReceptions,
  upsertPreparations,
  upsertItems,
  upsertParties,
  changeStock,
};
