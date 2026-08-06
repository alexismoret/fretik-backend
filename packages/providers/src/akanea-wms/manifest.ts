import type {
  ParamSpec,
  ProviderManifest,
} from "@fretik/shared/external-apps/manifest-schema";
import {
  itemFields,
  partyFields,
  preparationFields,
  receptionFields,
  stockChangeFields,
  toParamFields,
} from "./payloads";

/**
 * Akanea WMS (Xtent) provider manifest.
 *
 * Xtent is the warehouse-management product of Akanea, a French software
 * vendor; it is what a logistics operator runs inside the building. Its
 * two flows are receptions (goods coming IN) and preparations (picking
 * orders going OUT), over a catalogue of items and third parties.
 *
 * Transport is `custom-handler` rather than `http-direct` for two reasons
 * a declarative HTTP action cannot express:
 *  - the base URL belongs to the customer (each Xtent install has its own
 *    host), so it cannot be baked into the manifest;
 *  - authentication is a LICENSE LEASE, not a static key: `GetToken` takes
 *    a seat and `ReleaseToken` gives it back. See `client.ts`.
 *
 * Reads split into "header" actions and "actually-stored / actually-picked"
 * actions because Xtent models them as different payloads: the header says
 * what was announced, the stock list says what the warehouse floor really
 * did. Keeping them as separate actions keeps each return type honest.
 *
 * Deliberately out of scope for v1: `MultipleStockChanges` (a bulk
 * criteria-driven rewrite — too blunt for an agent to aim safely, and
 * `change_stock` covers the same ground one object at a time), plus the
 * customs / excise / accounting field families on every entity.
 */

/** Filter + sort pair shared by every query web service. */
const queryParams: Record<string, ParamSpec> = {
  filters: {
    type: "string",
    optional: true,
    description:
      'Xtent filter over the entity\'s PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.',
  },
  sorts: {
    type: "string",
    optional: true,
    description: "Sort expression, e.g. `Id desc` or `ItemCode asc,Id desc`.",
  },
  limit: {
    type: "integer",
    optional: true,
    default: 200,
    min: 1,
    max: 1000,
    description:
      "Caps the rows handed back. Xtent has no server-side paging, so a broad filter still costs the warehouse a full scan — narrow `filters` rather than raising this.",
  },
};

export const akaneaWmsManifest: ProviderManifest = {
  key: "akanea-wms",
  displayName: "Akanea WMS",
  description:
    "Akanea WMS (Xtent) — the warehouse-management system a logistics team runs on the floor. Check stock levels and movements, follow inbound receptions and outbound preparation orders, and push receptions, preparations, items, parties and stock corrections into the warehouse.",
  // Nango integration built from the `private-api-basic` template — used
  // purely as encrypted storage for the Xtent login. No OAuth, no proxy.
  nangoProviderConfigKey: "akanea-wms",
  icon: "/app-icons/akanea-wms.svg",
  iconColor: "#8B7CF3",
  categories: ["industry", "wms"],
  scopes: [],
  transport: { kind: "custom-handler" },

  credentialsForm: {
    fields: [
      {
        key: "base_url",
        labelKey:
          "settings.externalApps.providers.akanea-wms.fields.base_url.label",
        helpKey:
          "settings.externalApps.providers.akanea-wms.fields.base_url.help",
        kind: "text",
        target: "connection_config",
        required: true,
        pattern: "^https://",
      },
      {
        key: "access_id",
        labelKey:
          "settings.externalApps.providers.akanea-wms.fields.access_id.label",
        helpKey:
          "settings.externalApps.providers.akanea-wms.fields.access_id.help",
        kind: "text",
        target: "connection_config",
        required: true,
      },
      {
        // Basic-auth `username` slot of the Nango template — renamed on the
        // wire via `nangoKey`, read back as `credentials.user_id`.
        key: "user_id",
        labelKey:
          "settings.externalApps.providers.akanea-wms.fields.user_id.label",
        helpKey:
          "settings.externalApps.providers.akanea-wms.fields.user_id.help",
        kind: "text",
        target: "credentials",
        nangoKey: "username",
        required: true,
      },
      {
        key: "password",
        labelKey:
          "settings.externalApps.providers.akanea-wms.fields.password.label",
        helpKey:
          "settings.externalApps.providers.akanea-wms.fields.password.help",
        kind: "password",
        target: "credentials",
        required: true,
      },
    ],
    testConnection: { supported: true },
  },

  types: {
    /** Stock on hand for one item / batch / pallet combination. */
    ItemQuantity: {
      item_code: { type: "string", optional: true },
      client_code_id: {
        type: "string",
        optional: true,
        description: "Warehouse-customer (stockeur) code",
      },
      batch_number: { type: "string", optional: true },
      pallet: { type: "string", optional: true },
      warehouse_id: { type: "string", optional: true },
      status_id: { type: "string", optional: true },
      expiry_date: { type: "string", optional: true },
      fifo_date: { type: "string", optional: true },
      su_available: {
        type: "number",
        optional: true,
        description:
          "Sale units available to promise — net of running preparations",
      },
      su_real_stock: {
        type: "number",
        optional: true,
        description: "Sale units physically in stock",
      },
      su_reserved: { type: "number", optional: true },
      su_blocked: { type: "number", optional: true },
      su_stored: { type: "number", optional: true },
      parcels_available: { type: "number", optional: true },
      parcels_real_stock: { type: "number", optional: true },
      full_pallets_available: { type: "number", optional: true },
      full_pallets_real_stock: { type: "number", optional: true },
      gross_weight: { type: "number", optional: true },
      net_weight: { type: "number", optional: true },
    },
    /** One internal stock movement. */
    StockMovement: {
      id: { type: "integer", optional: true },
      item_code: { type: "string", optional: true },
      client_code_id: { type: "string", optional: true },
      movement_code: { type: "string", optional: true },
      movement_type: { type: "string", optional: true },
      movement_date: { type: "string", optional: true },
      creation_date: { type: "string", optional: true },
      batch_number: { type: "string", optional: true },
      pallet_number: { type: "string", optional: true },
      location_id: { type: "string", optional: true },
      status_id: { type: "string", optional: true },
      sales_unit: { type: "number", optional: true },
      unit_qty: { type: "number", optional: true },
      parcels: { type: "number", optional: true },
      full_pallets: { type: "number", optional: true },
      reception_id: { type: "integer", optional: true },
      preparation_id: { type: "integer", optional: true },
    },
    /** Inbound reception header. */
    Reception: {
      id: { type: "integer", optional: true },
      client_code_id: { type: "string", optional: true },
      order_reference: { type: "string", optional: true },
      movement_code_id: { type: "string", optional: true },
      order_status: {
        type: "string",
        optional: true,
        description:
          "A waiting, P planned, V validated, B intermediate, R reserved, Q dock, X deleted",
      },
      supplier_name: { type: "string", optional: true },
      supplier_reference: { type: "string", optional: true },
      carrier_name: { type: "string", optional: true },
      planned_receiving_date: { type: "string", optional: true },
      actual_receiving_date: { type: "string", optional: true },
      appointment_date: { type: "string", optional: true },
      arrival_date: { type: "string", optional: true },
      reception_warehouse_id: { type: "string", optional: true },
      truck_number: { type: "string", optional: true },
      number_of_lines: { type: "number", optional: true },
      number_of_pallets: { type: "number", optional: true },
      number_of_parcels: { type: "number", optional: true },
      number_of_sale_units: { type: "number", optional: true },
      creation_date: { type: "string", optional: true },
      validation_date: { type: "string", optional: true },
    },
    /** Outbound preparation (picking order) header. */
    Preparation: {
      id: { type: "integer", optional: true },
      client_code_id: { type: "string", optional: true },
      order_reference: { type: "string", optional: true },
      client_reference: { type: "string", optional: true },
      consignee_reference: { type: "string", optional: true },
      order_status: {
        type: "string",
        optional: true,
        description:
          "A waiting, P planned, V validated, B intermediate, R reserved, Q dock, X deleted",
      },
      consignee_name: { type: "string", optional: true },
      consignee_city_name: { type: "string", optional: true },
      consignee_country_id: { type: "string", optional: true },
      carrier_name: { type: "string", optional: true },
      planned_delivery_date: { type: "string", optional: true },
      imperative_delivery_date: { type: "string", optional: true },
      planned_preparation_date: { type: "string", optional: true },
      actual_preparation_date: { type: "string", optional: true },
      preparation_warehouse_id: { type: "string", optional: true },
      urgent: { type: "boolean", optional: true },
      number_of_lines: { type: "number", optional: true },
      number_of_pallets: { type: "number", optional: true },
      number_of_parcels: { type: "number", optional: true },
      number_of_sale_units: { type: "number", optional: true },
      creation_date: { type: "string", optional: true },
      validation_date: { type: "string", optional: true },
    },
    /** One physical stock object attached to a reception or preparation. */
    StockLine: {
      reception_id: { type: "integer", optional: true },
      preparation_id: { type: "integer", optional: true },
      item_code: { type: "string", optional: true },
      batch_number: { type: "string", optional: true },
      pallet_number: { type: "string", optional: true },
      location_id: { type: "string", optional: true },
      status_id: { type: "string", optional: true },
      sales_unit: { type: "number", optional: true },
      parcels: { type: "number", optional: true },
      full_pallets: { type: "number", optional: true },
      gross_weight: { type: "number", optional: true },
      net_weight: { type: "number", optional: true },
      expiry_date: { type: "string", optional: true },
      movement_date: { type: "string", optional: true },
    },
    /** One SSCC pallet label of a preparation. */
    SsccLine: {
      preparation_id: { type: "integer", optional: true },
      sscc: {
        type: "string",
        optional: true,
        description: "Serial Shipping Container Code of the labelled pallet",
      },
      pallet_number: { type: "string", optional: true },
      item_code: { type: "string", optional: true },
      batch_number: { type: "string", optional: true },
      sales_unit: { type: "number", optional: true },
      parcels: { type: "number", optional: true },
    },
    /** Item master record. */
    Item: {
      id: { type: "integer", optional: true },
      item_code: { type: "string", optional: true },
      client_code_id: { type: "string", optional: true },
      description: { type: "string", optional: true },
      external_reference: { type: "string", optional: true },
      family_code: { type: "string", optional: true },
      packaging_code: { type: "string", optional: true },
      unit_code: { type: "string", optional: true },
      supplier_code_id: { type: "string", optional: true },
      batch_management: { type: "string", optional: true },
      available: { type: "boolean", optional: true },
      inner: { type: "number", optional: true },
      outer: { type: "number", optional: true },
      layers_per_pallet: { type: "number", optional: true },
      parcels_per_layer: { type: "number", optional: true },
      parcel_gross_weight: { type: "number", optional: true },
      parcel_net_weight: { type: "number", optional: true },
    },
    /** Outcome of one integration flow. */
    FlowStatus: {
      flow_id: { type: "integer", optional: true },
      flow_status: {
        type: "string",
        optional: true,
        description: '"OK", or "KO" when at least one entity failed',
      },
      flow_type: { type: "string", optional: true },
      non_integrated_count: { type: "integer", optional: true },
      errors: { type: "array", items: { type: "string" } },
    },
    /** Integration status of one submitted entity. */
    EntityIntegrationStatus: {
      entity_id: { type: "integer", optional: true },
      status: {
        type: "string",
        optional: true,
        description:
          '"OK" when usable, "KO INTEGRATION" when Xtent never created it',
      },
      flow_id: { type: "integer", optional: true },
      errors: { type: "array", items: { type: "string" } },
    },
    /** What an `upsert_*` / `change_stock` call returns. */
    IntegrationResult: {
      flow_ids: {
        type: "array",
        items: { type: "integer" },
        description:
          "Flow ids to pass to check_flow_status on a LATER turn to confirm the data landed",
      },
      accepted_count: {
        type: "integer",
        optional: true,
        description:
          "Entities Xtent accepted — rows that came back with an error are excluded",
      },
      entity_ids: {
        type: "array",
        items: { type: "integer" },
        description:
          "Xtent ids of the created/updated entities, when echoed — pass them to check_entity_integration",
      },
      references: {
        type: "array",
        items: { type: "string" },
        description:
          "Per-entity references Xtent echoed back (order / supplier / item refs)",
      },
      errors: { type: "array", items: { type: "string" } },
    },
  },

  actions: [
    // ── Reads ────────────────────────────────────────────────────────
    {
      name: "get_item_quantities",
      kind: "read",
      summary: "List stock on hand per item, batch and pallet",
      handler: "getItemQuantities",
      params: queryParams,
      returns: { list: "ItemQuantity" },
    },
    {
      name: "list_stock_movements",
      kind: "read",
      summary: "List internal stock movements",
      handler: "listStockMovements",
      params: queryParams,
      returns: { list: "StockMovement" },
    },
    {
      name: "list_items",
      kind: "read",
      summary: "List item master records",
      handler: "listItems",
      params: queryParams,
      returns: { list: "Item" },
    },
    {
      name: "list_receptions",
      kind: "read",
      summary: "List inbound receptions",
      handler: "listReceptions",
      params: queryParams,
      returns: { list: "Reception" },
    },
    {
      name: "list_receptions_stored",
      kind: "read",
      summary: "List the stock actually put away for receptions",
      handler: "listReceptionsStored",
      params: queryParams,
      returns: { list: "StockLine" },
    },
    {
      name: "list_preparations",
      kind: "read",
      summary: "List outbound preparation orders",
      handler: "listPreparations",
      params: queryParams,
      returns: { list: "Preparation" },
    },
    {
      name: "list_preparations_prepared",
      kind: "read",
      summary: "List the stock actually picked for preparations",
      handler: "listPreparationsPrepared",
      params: queryParams,
      returns: { list: "StockLine" },
    },
    {
      name: "list_preparations_sscc",
      kind: "read",
      summary: "List SSCC pallet labels of preparations",
      handler: "listPreparationsSscc",
      params: queryParams,
      returns: { list: "SsccLine" },
    },
    {
      name: "check_flow_status",
      kind: "read",
      summary: "Check whether an integration flow was accepted",
      handler: "checkFlowStatus",
      params: {
        flow_id: {
          type: "integer",
          description:
            "Flow id returned by an upsert_* / change_stock call. Check it on a LATER turn — integration is asynchronous.",
        },
      },
      returns: { ref: "FlowStatus" },
    },
    {
      name: "check_entity_integration",
      kind: "read",
      summary: "Check the integration status of submitted entities",
      handler: "checkEntityIntegration",
      params: {
        entity_type: {
          type: "enum",
          values: ["Reception", "Preparation", "Item", "Party"],
          description: "Which kind of entity the ids refer to",
        },
        entity_ids: {
          type: "array",
          items: { type: "integer" },
          description: "Xtent ids of the entities to check",
        },
      },
      returns: { list: "EntityIntegrationStatus" },
    },

    // ── Writes ───────────────────────────────────────────────────────
    {
      name: "upsert_receptions",
      kind: "write",
      summary: "Create or update inbound receptions",
      handler: "upsertReceptions",
      params: {
        receptions: {
          type: "array",
          description:
            "Receptions to send. Each needs `client_code_id`, `movement_code_id` and at least one line (`line_number`, `item_code`, `expected_sale_units`). Set `id` to update an existing one. Only documented fields are transmitted — see the reception payload in the guidance below.",
          items: { type: "object", fields: toParamFields(receptionFields) },
        },
      },
      returns: { ref: "IntegrationResult" },
    },
    {
      name: "upsert_preparations",
      kind: "write",
      summary: "Create or update outbound preparation orders",
      handler: "upsertPreparations",
      params: {
        preparations: {
          type: "array",
          description:
            "Preparations to send. Each needs `client_code_id`, `consignee_code_id` and at least one line (`line_number`, `item_code`, `ordered_sale_units`). Set `id` to update an existing one. Only documented fields are transmitted — see the preparation payload in the guidance below.",
          items: { type: "object", fields: toParamFields(preparationFields) },
        },
      },
      returns: { ref: "IntegrationResult" },
    },
    {
      name: "upsert_items",
      kind: "write",
      summary: "Create or update item master records",
      handler: "upsertItems",
      params: {
        items: {
          type: "array",
          description:
            "Items to send. Each needs `client_code_id`, `item_code`, `description` and at least one `priority_racks` entry (`warehouse_id`, `movement_type`). Only documented fields are transmitted — see the item payload in the guidance below.",
          items: { type: "object", fields: toParamFields(itemFields) },
        },
      },
      returns: { ref: "IntegrationResult" },
    },
    {
      name: "upsert_parties",
      kind: "write",
      summary: "Create or update third parties",
      handler: "upsertParties",
      params: {
        parties: {
          type: "array",
          description:
            "Parties to send. Each needs `id` (the party code); `party_category` picks F supplier, D consignee, S warehouse customer, T carrier. Only documented fields are transmitted — see the party payload in the guidance below.",
          items: { type: "object", fields: toParamFields(partyFields) },
        },
      },
      returns: { ref: "IntegrationResult" },
    },
    {
      name: "change_stock",
      kind: "write",
      summary: "Correct stock objects (status, location, batch, dates)",
      handler: "changeStock",
      params: {
        stock_changes: {
          type: "array",
          description:
            "Stock objects to modify, identified by `client_code_id` plus `pallet_number` and/or `item_code`. The reception holding the stock must already be validated. Only documented fields are transmitted — see the stock payload in the guidance below.",
          items: { type: "object", fields: toParamFields(stockChangeFields) },
        },
      },
      returns: { ref: "IntegrationResult" },
    },
  ],
};
