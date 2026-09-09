import type {
  ManifestAction,
  ParamSpec,
  ProviderManifest,
} from "@fretik/shared/external-apps/manifest-schema";

/**
 * Pbyp — freight-forwarding TMS (sea & air) built on Directus.
 *
 * Transport is `http-direct`: Pbyp is not on Nango's catalog, so the user
 * pastes a personal API key (generated on their Pbyp profile page) plus the
 * profile they want the connection to act under, Nango stores both, and the
 * generic executor fires `fetch()` at the Directus REST API with
 * `Authorization: Bearer <key>`.
 *
 * The action catalogue is deliberately GENERIC FIRST. Five actions cover
 * the whole of Directus (`describe_collection`, `query_items`,
 * `create_items`, `update_items`, `delete_items`) across 91 collections,
 * hardened in `mappers.ts` with the whitelists, computed-field stripping,
 * relation-shape checks and secret scrubbing from `invariants.ts`. A typed
 * action is added only where it CHANGES BEHAVIOUR — an endpoint outside
 * `/items` (the Directus bundle's own routes), a payload whose shape the
 * schema cannot express, or an operation sensitive enough to deserve its
 * own approval card. Anything else would be a maintenance surface that
 * drifts every time Pbyp evolves, and 450 lines of SKILL the agent reads
 * on every conversation.
 */

// ── Shared param specs ────────────────────────────────────────────────

const MODULE: ParamSpec = {
  type: "enum",
  values: ["sea", "air"],
  description:
    "Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.",
};

const LIMIT: ParamSpec = {
  type: "integer",
  optional: true,
  default: 25,
  min: -1,
  max: 200,
  description:
    "Rows to return: 1-200, or -1 for every row. Ask for -1 only when you will use all of them — to answer 'how many' or 'which is the most', count with `aggregate` instead and read one row per group.",
};

const PAGE: ParamSpec = {
  type: "integer",
  optional: true,
  default: 1,
  min: 1,
  description: "1-based page number, used with `limit`.",
};

const FREE_OBJECT: ParamSpec = {
  type: "object",
  fields: {},
};

/** Which of the six object families an event or a share targets. */
const TARGET_TYPE: ParamSpec = {
  type: "enum",
  values: [
    "order",
    "sea_folder",
    "air_folder",
    "sea_booking",
    "air_booking",
    "container",
  ],
  description: "The object family the row hangs off.",
};

const SHAREABLE: ParamSpec = {
  type: "enum",
  values: ["order", "sea_folder", "air_folder"],
  description: "Only orders and folders can be shared with another entity.",
};

const ARCHIVABLE: ParamSpec = {
  type: "enum",
  values: [
    "order",
    "sea_folder",
    "air_folder",
    "sea_booking",
    "air_booking",
    "container",
    "quotation",
  ],
  description: "The object to cancel.",
};

// ── Reusable return types ─────────────────────────────────────────────

const types: ProviderManifest["types"] = {
  Me: {
    user_id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    profile_id: { type: "integer", optional: true },
    profile_role: { type: "string", optional: true },
    entity_id: {
      type: "integer",
      optional: true,
      description: "The entity the active profile belongs to.",
    },
    entity_name: { type: "string", optional: true },
    is_client: {
      type: "boolean",
      optional: true,
      description:
        "true = a shipper account (sees only its own shipments). false = a freight forwarder.",
    },
    current_entities: {
      type: "array",
      items: { type: "integer" },
      description:
        "Server-enforced scope: every entity id this connection can see. Empty means it sees nothing.",
    },
  },

  Profile: {
    id: { type: "integer" },
    entity_id: { type: "integer" },
    entity_name: { type: "string" },
    role: { type: "string", optional: true },
    is_client: { type: "boolean", optional: true },
  },

  FieldDoc: {
    collection: { type: "string" },
    field: { type: "string" },
    type: { type: "string" },
    required: {
      type: "boolean",
      optional: true,
      description: "Must be supplied on create.",
    },
    computed: {
      type: "boolean",
      optional: true,
      description:
        "Written by a Pbyp hook. Never send it — it is stripped from writes.",
    },
    links_to: {
      type: "string",
      optional: true,
      description: "The collection on the far side of the link.",
    },
    path: {
      type: "string",
      optional: true,
      description:
        "The literal prefix to put in fields or filter to reach across the link — e.g. `consignee` for a direct link, `parcels.parcels_id` for a many-to-many. Append `.<column>`. Write this, never guess it.",
    },
    choices: {
      type: "array",
      items: { type: "string" },
      optional: true,
      description: "The only values this column accepts.",
    },
    note: { type: "string", optional: true },
  },

  StoredFile: {
    id: {
      type: "string",
      description:
        "The uuid to put in `files.file` when you link this document to a shipment.",
    },
    filename_download: { type: "string" },
    type: { type: "string", description: "MIME type as stored." },
    filesize: { type: "integer", description: "Bytes." },
  },

  Event: {
    id: { type: "integer" },
    code: { type: "string" },
    type_id: { type: "integer" },
    label: { type: "string", optional: true },
    date: { type: "string" },
    actual: {
      type: "boolean",
      description: "true = it happened. false = it is still forecast.",
    },
    source: { type: "string", description: "user | tracking | ptd" },
    terminal: { type: "string", optional: true },
    address: { type: "string", optional: true },
    comments: { type: "string", optional: true },
  },

  EventType: {
    id: { type: "integer" },
    code: { type: "string" },
    label: { type: "string", optional: true },
    modules: { type: "array", items: { type: "string" } },
    category: { type: "array", items: { type: "string" } },
  },

  Gateway: {
    id: { type: "integer" },
    external_code: { type: "string" },
    gateway_type: { type: "integer" },
    gateway_label: {
      type: "string",
      optional: true,
      description: "Partner name — PTD, Shiptify, …",
    },
    entity_id: { type: "integer", optional: true },
    status: { type: "string", optional: true },
  },

  StatusCount: {
    shipping_status: { type: "string" },
    count: { type: "integer" },
  },

  Counter: {
    counter: {
      type: "string",
      description: "This month's next sequence, zero-padded to 4 digits.",
    },
    month_key: {
      type: "string",
      description: "YYYYMM, as the number uses it.",
    },
    pattern: {
      type: "string",
      description: "How to assemble the final number from your entity id.",
    },
  },
};

// ── Generic Directus surface ──────────────────────────────────────────

const genericActions: ManifestAction[] = [
  {
    name: "describe_collection",
    kind: "read",
    summary:
      "The shape of up to 5 collections at once. Returns ONE ROW PER COLUMN — a flat list across every collection asked for, each row carrying its own `collection` — with whether the column is required or computed, a dropdown's allowed values, and for a link the exact path to write in fields or filter.",
    endpoint: { method: "GET", path: "/fields" },
    params: {
      collections: {
        type: "array",
        items: { type: "string" },
        description:
          'Collection names, e.g. ["orders", "air_folders", "terminals"]. Ask for every table your question touches in ONE call.',
      },
    },
    returns: { list: "FieldDoc" },
    request: "describeFields",
    response: "describeCollection",
  },
  {
    name: "query_items",
    kind: "read",
    summary:
      "Read or count any collection: filter, nested field paths, sort, search, deep, aggregate. This is how you find things — there is no separate search action.",
    endpoint: { method: "GET", path: "/items/{collection}" },
    params: {
      collection: { type: "string", in: "path" },
      filter: {
        ...FREE_OBJECT,
        optional: true,
        description:
          'Directus filter, e.g. {"shipping_status": {"_eq": "IN_TRANSIT"}}. Operators: _eq _neq _in _nin _lt _lte _gt _gte _null _nnull _contains _icontains _starts_with _between _and _or.',
      },
      fields: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description:
          'Fields to return. A nested path resolves a link in the SAME call ("consignee.country_id.name") — take the prefix from describe_collection, never guess it. Omit this and the main shipment collections return a curated set with names already resolved.',
      },
      include_archived: {
        type: "boolean",
        optional: true,
        default: false,
        description:
          "Pbyp cancels by archiving. Reads exclude archived rows unless you set this, or filter on `status` yourself.",
      },
      sort: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description: 'e.g. ["-date_created"].',
      },
      limit: LIMIT,
      page: PAGE,
      search: {
        type: "string",
        optional: true,
        description: "Full-text search across the collection's string fields.",
      },
      deep: {
        ...FREE_OBJECT,
        optional: true,
        description:
          'Per-relation query, e.g. {"events": {"_sort": ["-date"], "_limit": 5}}.',
      },
      aggregate: {
        ...FREE_OBJECT,
        optional: true,
        description: 'e.g. {"count": "id"} or {"sum": "total_weight"}.',
      },
      group_by: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description: "Grouping keys, used with `aggregate`.",
      },
    },
    returns: {
      fields: {
        items: { type: "array", items: FREE_OBJECT },
      },
    },
    request: "queryItems",
    response: "itemsResult",
  },
  {
    name: "create_items",
    kind: "write",
    summary:
      "Create one or more rows in any writable collection. Computed columns are stripped and reported back.",
    endpoint: { method: "POST", path: "/items/{collection}" },
    params: {
      collection: { type: "string", in: "path" },
      items: {
        type: "array",
        items: FREE_OBJECT,
        description:
          "One object per row. Call describe_collection() first when unsure of the shape; many-to-many lists take junction rows, e.g. parcels: [{parcels_id: 41}].",
      },
    },
    returns: {
      fields: {
        collection: { type: "string" },
        ids: { type: "array", items: { type: "integer" } },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createItems",
    response: "writeResult",
  },
  {
    name: "update_items",
    kind: "write",
    summary:
      "Apply the same change to one or more rows of a collection, by id.",
    endpoint: { method: "PATCH", path: "/items/{collection}" },
    params: {
      collection: { type: "string", in: "path" },
      ids: {
        type: "array",
        items: { type: "integer" },
        description: "Primary keys to update.",
      },
      data: {
        ...FREE_OBJECT,
        description:
          "Fields to change. Same shapes as create; entity_id is refused (an object never changes owner).",
      },
    },
    returns: {
      fields: {
        collection: { type: "string" },
        ids: { type: "array", items: { type: "integer" } },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "updateItems",
    response: "writeResult",
  },
  {
    name: "delete_items",
    kind: "write",
    summary:
      "Permanently delete rows. Refused on orders, folders, bookings, containers and quotations — cancel those with archive().",
    endpoint: { method: "DELETE", path: "/items/{collection}" },
    params: {
      collection: { type: "string", in: "path" },
      ids: { type: "array", items: { type: "integer" } },
    },
    returns: { void: true },
    request: "deleteItems",
  },
  {
    name: "upload_file",
    kind: "read",
    summary:
      "Store a file's bytes in Pbyp and return the id to link it with. It is attached to NOTHING on its own — see 'Filing a document' in the guidance for the create_items call that puts it in an order's or a folder's GED.",
    endpoint: { method: "POST", path: "/files" },
    params: {
      filename: {
        type: "string",
        description:
          "Name the document is shown and downloaded under, with its extension. No directories.",
      },
      content_base64: {
        type: "string",
        description:
          "The file's bytes, base64-encoded. Read them in the sandbox — `base64.b64encode(Path(p).read_bytes()).decode()` — and pass the variable; never paste the blob into your own text.",
      },
      content_type: {
        type: "string",
        optional: true,
        description:
          "MIME type. Derived from the extension when omitted, which is right for the formats a forwarder files.",
      },
    },
    returns: { ref: "StoredFile" },
    request: "uploadFile",
    response: "uploadedFile",
  },
];

// ── Typed reads ───────────────────────────────────────────────────────

const readActions: ManifestAction[] = [
  {
    name: "whoami",
    kind: "read",
    summary:
      "Who this connection acts as: the active profile, its entity, whether it is a forwarder or a client, and the entity ids it can see.",
    endpoint: { method: "GET", path: "/users/me" },
    params: {},
    returns: { ref: "Me" },
    request: "whoami",
    response: "whoami",
  },
  {
    name: "list_profiles",
    kind: "read",
    summary:
      "The profiles this account holds. Only one is active at a time — activate_profile() switches.",
    endpoint: { method: "GET", path: "/items/profiles" },
    params: {},
    returns: { list: "Profile" },
    request: "listProfiles",
    response: "profileList",
  },
  {
    name: "list_events",
    kind: "read",
    summary:
      "The event history of one object, most recent first — the milestones that drive its status.",
    endpoint: { method: "GET", path: "/items/events" },
    params: {
      target_type: TARGET_TYPE,
      target_id: { type: "integer" },
      limit: LIMIT,
    },
    returns: { list: "Event" },
    request: "listEvents",
    response: "eventList",
  },
  {
    name: "list_event_types",
    kind: "read",
    summary:
      "The event catalogue: which milestone codes exist, for which module, and what they can be attached to.",
    endpoint: { method: "GET", path: "/items/event_types" },
    params: {
      module: { ...MODULE, optional: true },
      category: {
        type: "enum",
        values: ["booking", "container", "folder", "order"],
        optional: true,
      },
    },
    returns: { list: "EventType" },
    request: "listEventTypes",
    response: "eventTypeList",
  },
  {
    name: "list_gateways",
    kind: "read",
    summary:
      "EDI gateways this account can see — the partners an object can be transferred to (PTD, …).",
    endpoint: { method: "GET", path: "/items/gateway_external" },
    params: {},
    returns: { list: "Gateway" },
    request: "listGateways",
    response: "gatewayList",
  },
  {
    name: "count_by_status",
    kind: "read",
    summary:
      "How many objects sit in each shipping status over a date window — the answer to 'how many are in transit'.",
    endpoint: { method: "GET", path: "/items/orders" },
    params: {
      object: {
        type: "enum",
        values: ["order", "folder", "booking", "container"],
      },
      module: { ...MODULE, optional: true },
      date_from: { type: "date", optional: true },
      date_to: { type: "date", optional: true },
    },
    returns: { list: "StatusCount" },
    request: "countByStatus",
    response: "statusCounts",
  },
  {
    name: "next_order_number",
    kind: "read",
    summary:
      "This month's next order sequence. Assemble the number as <entity_id>O<month_key><counter>.",
    endpoint: { method: "GET", path: "/order-endpoints/month_count" },
    params: { module: MODULE },
    returns: { ref: "Counter" },
    request: "monthCount",
    response: "orderCounter",
  },
  {
    name: "next_quotation_number",
    kind: "read",
    summary:
      "This month's next quotation sequence. Assemble the number as Q<entity_id><month_key><counter>.",
    endpoint: { method: "GET", path: "/quotation-endpoints/month_count" },
    params: {},
    returns: { ref: "Counter" },
    response: "quotationCounter",
  },
];

// ── Typed writes ──────────────────────────────────────────────────────

const addressRef: ParamSpec = {
  type: "object",
  description:
    "A party. Either { id } for an existing address, or the full shape to create one: { name, code, address, city, zipcode, country_id | code_country, email?, phone?, complement? }.",
  fields: {
    id: { type: "integer", optional: true },
    name: { type: "string", optional: true },
    code: { type: "string", optional: true },
    address: { type: "string", optional: true },
    city: { type: "string", optional: true },
    zipcode: { type: "string", optional: true },
    country_id: { type: "integer", optional: true },
    code_country: {
      type: "string",
      optional: true,
      description: "ISO 3166-1 alpha-2, when country_id is unknown.",
    },
    complement: { type: "string", optional: true },
    email: { type: "email", optional: true },
    phone: { type: "string", optional: true },
  },
};

const parcelLine: ParamSpec = {
  type: "object",
  description:
    "One cargo line. `taxable_weight` is computed when omitted (sea: volume x 1000, air: volume x 167).",
  fields: {
    type: {
      type: "string",
      description: "Packaging, e.g. Carton, Palette, Colis.",
    },
    quantity: { type: "integer" },
    weight: { type: "number", optional: true, description: "kg, total." },
    volume: { type: "number", optional: true, description: "m3, total." },
    meterage: { type: "number", optional: true, description: "Linear metres." },
    taxable_weight: { type: "number", optional: true },
    description: { type: "string", optional: true },
    is_adr: { type: "boolean", optional: true },
    adr_ids: {
      type: "array",
      items: { type: "integer" },
      optional: true,
      description: "Dangerous-goods classes, from the `adr` collection.",
    },
    is_controlled_temperature: { type: "boolean", optional: true },
    minimal_temperature: { type: "number", optional: true },
    maximal_temperature: { type: "number", optional: true },
  },
};

const writeActions: ManifestAction[] = [
  {
    name: "create_order",
    kind: "write",
    summary:
      "Create an order: parties, incoterm, dates and cargo lines in one call.",
    endpoint: { method: "POST", path: "/items/orders" },
    params: {
      module: MODULE,
      number: {
        type: "string",
        description: "From next_order_number() — see its pattern.",
      },
      date: { type: "date", description: "Order date (calendar day)." },
      incoterm: {
        type: "enum",
        values: [
          "EXW",
          "FCA",
          "FAS",
          "FOB",
          "CFR",
          "CIF",
          "CPT",
          "CIP",
          "DAP",
          "DPU",
          "DDP",
        ],
      },
      entity_id: {
        type: "integer",
        description:
          "Owning agency — whoami().entity_id unless told otherwise.",
      },
      shipper: addressRef,
      consignee: addressRef,
      client_reference: { type: "string", optional: true },
      billing_reference: { type: "string", optional: true },
      comments: { type: "string", optional: true, excludeFromHash: true },
      pickup_date: { type: "datetime", optional: true },
      delivery_date: { type: "date", optional: true },
      available_date: { type: "date", optional: true },
      deadline: { type: "datetime", optional: true },
      parcels: { type: "array", items: parcelLine, optional: true },
      parcels_description: { type: "string", optional: true },
      parcels_price: { type: "number", optional: true },
      parcels_price_currency: {
        type: "enum",
        values: ["EUR", "USD"],
        optional: true,
      },
      folder_id: {
        type: "integer",
        optional: true,
        description: "Attach to this folder straight away (same module).",
      },
      shared_with: {
        type: "array",
        optional: true,
        items: {
          type: "object",
          fields: {
            entity_id: { type: "integer" },
            can_edit: { type: "boolean", optional: true, default: false },
          },
        },
        description: "Entities that should also see this order.",
      },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        number: { type: "string" },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createOrder",
    response: "writeResult",
  },
  {
    name: "create_folder",
    kind: "write",
    summary:
      "Create a transport folder — the file for one shipment. The folder number is assigned by Pbyp.",
    endpoint: { method: "POST", path: "/items/sea_folders" },
    params: {
      module: MODULE,
      folder_type: {
        type: "enum",
        values: ["single", "master", "house"],
        description:
          "single = one shipment. master groups houses. house must name its master_id.",
      },
      date: { type: "date" },
      incoterm: {
        type: "enum",
        values: [
          "EXW",
          "FCA",
          "FAS",
          "FOB",
          "CFR",
          "CIF",
          "CPT",
          "CIP",
          "DAP",
          "DPU",
          "DDP",
        ],
      },
      entity_id: { type: "integer" },
      shipper: addressRef,
      consignee: addressRef,
      payer_id: {
        type: "integer",
        optional: true,
        description: "Billed entity. Required unless folder_type is master.",
      },
      master_id: {
        type: "integer",
        optional: true,
        description: "Required when folder_type is house.",
      },
      voyage_id: {
        type: "integer",
        optional: true,
        description: "The booking this folder travels on.",
      },
      client_reference: { type: "string", optional: true },
      billing_reference: { type: "string", optional: true },
      comments: { type: "string", optional: true, excludeFromHash: true },
      pickup_date: { type: "datetime", optional: true },
      delivery_date: { type: "date", optional: true },
      order_ids: {
        type: "array",
        items: { type: "integer" },
        optional: true,
        description: "Orders to attach on creation.",
      },
      parcels: { type: "array", items: parcelLine, optional: true },
      shared_with: {
        type: "array",
        optional: true,
        items: {
          type: "object",
          fields: {
            entity_id: { type: "integer" },
            can_edit: { type: "boolean", optional: true, default: false },
          },
        },
      },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createFolder",
    response: "writeResult",
  },
  {
    name: "create_sea_booking",
    kind: "write",
    summary: "Create a sea voyage, optionally with its containers.",
    endpoint: { method: "POST", path: "/items/sea_bookings" },
    params: {
      booking_number: { type: "string" },
      entity_id: { type: "integer" },
      booking_type: {
        type: "enum",
        values: ["import", "export"],
        description: "Direction of the voyage for this agency.",
      },
      departure_terminal: {
        type: "integer",
        description: "Port of loading, from `terminals`.",
      },
      arrival_terminal: {
        type: "integer",
        description: "Port of discharge, from `terminals`.",
      },
      ETD: { type: "datetime" },
      ETA: { type: "datetime" },
      ship_name: { type: "string", optional: true },
      voyage_number: { type: "string", optional: true },
      BL_number: { type: "string", optional: true },
      agent_code: { type: "string", optional: true },
      company_id: {
        type: "integer",
        optional: true,
        description:
          "Shipping line from `oversea_companies`. Use custom_company instead when it is not listed — never both.",
      },
      custom_company: { type: "string", optional: true },
      containers: {
        type: "array",
        optional: true,
        items: {
          type: "object",
          fields: {
            number: {
              type: "string",
              description:
                "ISO 6346, e.g. CMAU0945402. Use TMPU0000003 when unknown.",
            },
            type: {
              type: "enum",
              values: [
                "10D",
                "10HC",
                "20D",
                "20HC",
                "20R",
                "40D",
                "40HC",
                "40R",
                "45",
                "20OT",
                "40OT",
                "20FR",
                "40FR",
              ],
            },
            shipping_method: {
              type: "enum",
              values: ["FCL/FCL", "FCL/LCL", "LCL/LCL", "LCL/FCL", "RORO"],
              optional: true,
            },
          },
        },
      },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createSeaBooking",
    response: "writeResult",
  },
  {
    name: "create_air_booking",
    kind: "write",
    summary:
      "Create an air booking with its flight legs. ETD, ETA and the terminals are derived from the legs.",
    endpoint: { method: "POST", path: "/items/air_bookings" },
    params: {
      booking_number: { type: "string" },
      entity_id: { type: "integer" },
      booking_type: {
        type: "enum",
        values: ["import", "export"],
        description: "Direction of the flight for this agency.",
      },
      LTA: {
        type: "string",
        description:
          "Air waybill: 3-digit airline prefix + 8 digits, last is a modulo-7 check.",
      },
      voyage_number: { type: "string", optional: true },
      agent_code: { type: "string", optional: true },
      airline_company: { type: "integer", optional: true },
      custom_company: { type: "string", optional: true },
      flights: {
        type: "array",
        items: {
          type: "object",
          fields: {
            number: { type: "string", optional: true },
            pol: { type: "integer", description: "Departure airport id." },
            pod: { type: "integer", description: "Arrival airport id." },
            etd: { type: "datetime" },
            eta: { type: "datetime" },
          },
        },
        description: "One entry per leg, in order.",
      },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createAirBooking",
    response: "writeResult",
  },
  {
    name: "create_quotation",
    kind: "write",
    summary: "Create a quotation with its purchase and sale lines.",
    endpoint: { method: "POST", path: "/items/quotations" },
    params: {
      number: {
        type: "string",
        description: "From next_quotation_number() — see its pattern.",
      },
      entity_id: { type: "integer" },
      transport_type: MODULE,
      booking_type: {
        type: "enum",
        values: ["import", "export"],
        description: "Direction of the shipment being priced.",
      },
      incoterm: {
        type: "enum",
        values: [
          "EXW",
          "FCA",
          "FAS",
          "FOB",
          "CFR",
          "CIF",
          "CPT",
          "CIP",
          "DAP",
          "DPU",
          "DDP",
        ],
      },
      margin: {
        type: "number",
        description: "Margin applied to the purchase lines, in percent.",
      },
      counterparty: {
        type: "integer",
        description:
          "The OTHER side of the quotation: the client entity when you are the freight forwarder, the forwarder entity when you are the client. Your own side is filled in by Pbyp from entity_id.",
      },
      shipper: addressRef,
      consignee: addressRef,
      departure_terminal: { type: "integer" },
      arrival_terminal: { type: "integer" },
      etd: { type: "datetime" },
      eta: { type: "datetime" },
      validity_start_date: { type: "date", optional: true },
      validity_end_date: { type: "date", optional: true },
      comments: { type: "string", optional: true, excludeFromHash: true },
      parcels: { type: "array", items: parcelLine, optional: true },
      quotes: {
        type: "array",
        optional: true,
        items: {
          type: "object",
          fields: {
            code: { type: "string", description: "Charge code." },
            name: { type: "string", optional: true },
            type: { type: "enum", values: ["purchases", "sales"] },
            amount_currency: { type: "number" },
            currency: { type: "string", description: "ISO code, e.g. EUR." },
            conversion_rate: { type: "number", optional: true, default: 1 },
          },
        },
      },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        number: { type: "string" },
        stripped: { type: "array", items: { type: "string" } },
      },
    },
    request: "createQuotation",
    response: "writeResult",
  },
  {
    name: "add_event",
    kind: "write",
    summary:
      "Record a milestone on one object. Events drive shipping_status — this is how a shipment advances.",
    endpoint: { method: "POST", path: "/items/events" },
    params: {
      target_type: TARGET_TYPE,
      target_id: { type: "integer" },
      event_type_id: {
        type: "integer",
        description: "From list_event_types() — must allow this module.",
      },
      date: { type: "datetime", description: "When the milestone happened." },
      actual: {
        type: "boolean",
        optional: true,
        description:
          "true = it happened, false = still forecast. Defaults to false for a future date.",
      },
      terminal_id: { type: "integer", optional: true },
      address_id: { type: "integer", optional: true },
      comments: { type: "string", optional: true, excludeFromHash: true },
    },
    returns: {
      fields: {
        id: { type: "integer", optional: true },
        deduplicated: {
          type: "boolean",
          description:
            "true when Pbyp already had this event and updated it instead. Still a success.",
        },
      },
    },
    request: "addEvent",
    response: "eventWrite",
  },
  {
    name: "set_parcels",
    kind: "write",
    summary:
      "Replace the cargo lines of an order or a folder. The previous list is dropped.",
    endpoint: { method: "PATCH", path: "/items/orders" },
    params: {
      target_type: {
        type: "enum",
        values: ["order", "sea_folder", "air_folder"],
      },
      target_id: { type: "integer" },
      parcels: { type: "array", items: parcelLine },
    },
    returns: {
      fields: {
        id: { type: "integer" },
        parcel_count: { type: "integer" },
      },
    },
    request: "setParcels",
    response: "writeResult",
  },
  {
    name: "attach_order_to_folder",
    kind: "write",
    summary: "Link an order to a folder of the same module.",
    endpoint: { method: "POST", path: "/items/sea_folders_orders" },
    params: {
      module: MODULE,
      order_id: { type: "integer" },
      folder_id: { type: "integer" },
    },
    returns: { fields: { id: { type: "integer" } } },
    request: "attachOrderToFolder",
    response: "writeResult",
  },
  {
    name: "detach_order_from_folder",
    kind: "write",
    summary: "Unlink an order from a folder.",
    endpoint: { method: "DELETE", path: "/items/sea_folders_orders" },
    params: {
      module: MODULE,
      order_id: { type: "integer" },
      folder_id: { type: "integer" },
    },
    returns: { void: true },
    request: "detachOrderFromFolder",
  },
  {
    name: "share_with_entity",
    kind: "write",
    summary:
      "Give another entity access to an order or a folder — it will see it in its own Pbyp.",
    endpoint: { method: "POST", path: "/items/orders_entities" },
    params: {
      object: SHAREABLE,
      object_id: { type: "integer" },
      entity_id: { type: "integer" },
      can_edit: { type: "boolean", optional: true, default: false },
    },
    returns: { fields: { id: { type: "integer" } } },
    request: "shareWithEntity",
    response: "writeResult",
  },
  {
    name: "revoke_share",
    kind: "write",
    summary: "Remove an entity's access to an order or a folder.",
    endpoint: { method: "DELETE", path: "/items/orders_entities" },
    params: {
      object: SHAREABLE,
      object_id: { type: "integer" },
      entity_id: { type: "integer" },
    },
    returns: { void: true },
    request: "revokeShare",
  },
  {
    name: "archive",
    kind: "write",
    summary:
      "Cancel an object. Pbyp archives rather than deletes: the status becomes CANCELED and the cancellation cascades.",
    endpoint: { method: "PATCH", path: "/items/orders" },
    params: {
      object: ARCHIVABLE,
      object_id: { type: "integer" },
    },
    returns: { fields: { id: { type: "integer" } } },
    request: "archiveObject",
    response: "writeResult",
  },
  {
    name: "set_quotation_status",
    kind: "write",
    summary: "Move a quotation through its workflow.",
    endpoint: { method: "PATCH", path: "/items/quotations" },
    params: {
      quotation_id: { type: "integer" },
      quotation_status: {
        type: "enum",
        values: [
          "DRAFT",
          "TRANSFERRED_TO_CLIENT",
          "TRANSFERRED_TO_FREIGHT_FORWARDER",
          "ACCEPTED",
          "DECLINED",
          "CANCELED",
        ],
        description:
          "A forwarder sends with TRANSFERRED_TO_CLIENT, a client asks with TRANSFERRED_TO_FREIGHT_FORWARDER; the receiving side then ACCEPTED or DECLINED. CANCELED is always allowed.",
      },
    },
    returns: { fields: { id: { type: "integer" } } },
    request: "setQuotationStatus",
    response: "writeResult",
  },
  {
    name: "transfer_to_gateway",
    kind: "write",
    summary:
      "Enrol an object in an EDI gateway (PTD, …) so the partner picks it up on its next pull.",
    endpoint: { method: "POST", path: "/items/folder_edi" },
    params: {
      object: {
        type: "enum",
        values: [
          "order",
          "sea_folder",
          "air_folder",
          "sea_booking",
          "air_booking",
          "event",
        ],
      },
      object_id: { type: "integer" },
      gateway_id: {
        type: "integer",
        description: "From list_gateways().",
      },
      external_reference: {
        type: "string",
        optional: true,
        description:
          "Events only — the partner's own reference for the object.",
      },
    },
    returns: {
      fields: {
        journal_id: { type: "integer" },
        journal_collection: { type: "string" },
      },
    },
    request: "transferToGateway",
    response: "writeResult",
  },
  {
    name: "assign_containers",
    kind: "write",
    summary:
      "Stuff an order's or a folder's cargo into containers — fully, or line by line across several boxes.",
    endpoint: { method: "POST", path: "/folder-endpoints/assign_containers" },
    params: {
      scope: { type: "enum", values: ["order", "folder"] },
      items: {
        type: "array",
        items: {
          type: "object",
          fields: {
            id: { type: "integer", description: "Order or folder id." },
            container_link_type: {
              type: "enum",
              values: ["full", "dispatched"],
              description:
                "full = everything goes in container_id. dispatched = each parcel line names its own container.",
            },
            container_id: {
              type: "integer",
              optional: true,
              description: "Required when full.",
            },
            parcels: {
              type: "array",
              optional: true,
              description: "Required when dispatched.",
              items: {
                type: "object",
                fields: {
                  id: {
                    type: "integer",
                    optional: true,
                    description: "Existing parcel line, when splitting one.",
                  },
                  type: { type: "string" },
                  quantity: { type: "integer" },
                  weight: { type: "number", optional: true },
                  volume: { type: "number", optional: true },
                  meterage: { type: "number", optional: true },
                  taxable_weight: { type: "number", optional: true },
                  container_id: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
    returns: { fields: { success: { type: "boolean" } } },
    request: "assignContainers",
  },
  {
    name: "unassign_parcel_container",
    kind: "write",
    summary:
      "Take one cargo line back out of its container. The quantity returns to the unassigned line.",
    endpoint: { method: "DELETE", path: "/folder-endpoints/parcel_container" },
    params: {
      scope: { type: "enum", values: ["order", "folder"] },
      target_id: { type: "integer", description: "Order or folder id." },
      parcel_id: { type: "integer" },
    },
    returns: { fields: { id: { type: "integer" } } },
    request: "unassignParcelContainer",
  },
  {
    name: "activate_profile",
    kind: "write",
    summary:
      "Switch the active profile. This changes what this connection — and the user's own Pbyp session — can see.",
    endpoint: { method: "POST", path: "/auth-endpoints/profile/{profile_id}" },
    params: {
      profile_id: { type: "integer", in: "path" },
    },
    returns: { fields: { id: { type: "integer" } } },
    response: "writeResult",
  },
  {
    name: "create_gateway",
    kind: "write",
    summary:
      "Create an EDI gateway for an entity — this also creates the partner's access account.",
    endpoint: { method: "POST", path: "/edi-endpoints/addgatewayexternal" },
    params: {
      gateway_type: {
        type: "integer",
        description: "Partner type id from `external_reference_types`.",
      },
      external_code: {
        type: "string",
        description: "The partner's code for this entity.",
      },
      entity_id: { type: "integer" },
    },
    returns: { fields: { status: { type: "string" } } },
    request: "createGateway",
  },
  {
    name: "update_gateway",
    kind: "write",
    summary: "Change an existing gateway's partner type or code.",
    endpoint: { method: "POST", path: "/edi-endpoints/addgatewayexternal" },
    params: {
      gateway_id: { type: "integer" },
      gateway_type: { type: "integer" },
      external_code: { type: "string" },
    },
    returns: { fields: { status: { type: "string" } } },
    request: "updateGateway",
  },
  {
    name: "declare_tracking",
    kind: "write",
    summary:
      "Register a booking with the carrier tracking service, so events start arriving on their own.",
    endpoint: { method: "POST", path: "/tracking-endpoints/create" },
    params: {
      module: MODULE,
      booking_id: { type: "integer" },
    },
    returns: { fields: { status: { type: "string" } } },
    request: "declareTracking",
  },
  {
    name: "create_lta_stock",
    kind: "write",
    summary:
      "Reserve a range of air waybill numbers for an entity and an airline.",
    endpoint: { method: "POST", path: "/lta-endpoints/createAirWayBillStock" },
    params: {
      first_awb: {
        type: "string",
        description: "First number of the range, 8 digits.",
      },
      last_awb: { type: "string", description: "Last number, 8 digits." },
      airline_company: { type: "integer" },
      entity_id: { type: "integer" },
    },
    returns: {
      fields: {
        success: { type: "boolean" },
        created_count: { type: "integer" },
      },
    },
    request: "createLtaStock",
  },
  {
    name: "invite_user",
    kind: "write",
    summary:
      "Invite someone to an entity with a role. They receive an e-mail invitation.",
    endpoint: { method: "POST", path: "/auth-endpoints/user/invite" },
    params: {
      first_name: { type: "string" },
      last_name: { type: "string" },
      email: { type: "email" },
      phone: { type: "string", optional: true },
      role_id: { type: "integer", description: "From the `roles` collection." },
      entity_id: { type: "integer" },
    },
    returns: { fields: { id: { type: "string" } } },
    request: "inviteUser",
    response: "writeResult",
  },
  {
    name: "create_client",
    kind: "write",
    summary:
      "Create a client company under an agency: the entity, its address book, its roles and its first admin account.",
    endpoint: { method: "POST", path: "/auth-endpoints/client" },
    params: {
      agency_id: {
        type: "integer",
        description: "The agency this client belongs to.",
      },
      name: { type: "string" },
      admin_user: {
        type: "object",
        fields: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "email" },
          phone: { type: "string", optional: true },
        },
      },
      commercial: {
        type: "object",
        description: "The account manager on your side.",
        fields: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "email", optional: true },
          phone: { type: "string", optional: true },
        },
      },
      address: {
        type: "object",
        fields: {
          name: { type: "string" },
          code: { type: "string" },
          address: { type: "string", optional: true },
          city: { type: "string", optional: true },
          zipcode: { type: "string", optional: true },
          country_id: { type: "integer", optional: true },
          code_country: { type: "string", optional: true },
          complement: { type: "string", optional: true },
          email: { type: "email", optional: true },
          phone: { type: "string", optional: true },
        },
      },
    },
    returns: { fields: { id: { type: "string" } } },
    request: "createClient",
    response: "writeResult",
  },
];

export const pbypManifest: ProviderManifest = {
  key: "pbyp",
  displayName: "Pbyp",
  description:
    "Pbyp — freight-forwarding TMS (sea & air): orders, transport folders, voyages and flights with their carrier, containers, cargo lines, tracking events, quotations, address book, and EDI transfers to partner gateways such as PTD.",
  nangoProviderConfigKey: "pbyp",
  icon: "/app-icons/pbyp.png",
  scopes: [],
  categories: ["industry", "tms"],
  transport: {
    kind: "http-direct",
    baseUrl: "https://directus.preprod.pbyp.fr",
    auth: {
      kind: "header",
      name: "Authorization",
      source: "credentials.api_key",
      scheme: "Bearer ",
    },
  },
  /**
   * One call at a time per connection. Pbyp derives `shipping_status` from
   * the events behind a Redis mutex and cascades the result to the
   * container, the folder and the order; two writes landing together on
   * the same shipment race that derivation, and the loser's status is the
   * one that sticks.
   */
  concurrency: { mode: "serial", maxWaitMs: 15_000 },
  credentialsForm: {
    fields: [
      {
        key: "api_key",
        labelKey: "settings.externalApps.providers.pbyp.fields.api_key.label",
        helpKey: "settings.externalApps.providers.pbyp.fields.api_key.help",
        kind: "password",
        target: "credentials",
        required: true,
        // Nango's `private-api-bearer` template stores the secret at
        // `credentials.apiKey`; we read it back as `api_key`.
        nangoKey: "apiKey",
      },
      {
        key: "profile_id",
        labelKey:
          "settings.externalApps.providers.pbyp.fields.profile_id.label",
        helpKey: "settings.externalApps.providers.pbyp.fields.profile_id.help",
        kind: "dynamic-select",
        target: "connection_config",
        required: true,
        dependsOn: ["api_key"],
        optionsHandler: "listProfiles",
      },
    ],
    testConnection: { supported: true },
  },
  /**
   * No `connectionOptions`, deliberately. The form asks for the API key and
   * the profile, and nothing else.
   *
   * The tempting pair — the entity's name and `is_client` — would go into
   * the system prompt via `exposeToAgent`, saving the agent one `whoami()`.
   * Not worth it here, for two reasons. `whoami()` is a single eager read
   * that the guidance already makes step one, so the saving is one cheap
   * call. And a `connectionOptions` field is EDITABLE: a boolean defaulting
   * to `false` tells the prompt "this is a freight forwarder" on every
   * client account whose owner never touched the switch — the agent then
   * looks for master folders and speaks BL/POL/POD to a shipper. A wrong
   * fact in the prompt costs more than an absent one.
   *
   * Contrast Shiptify's `account_type`, which earns its place: there the
   * role decides WHICH action family to call, a wrong guess is a 403, and
   * nothing cheap reveals it. Here `is_client` changes tone, not routing.
   *
   * The connection stays identifiable without it: the modal prefills
   * `displayName` from the chosen profile's label, so the row reads
   * "Pbyp — Fibertex — Admin" in the settings list.
   */
  types,
  actions: [...genericActions, ...readActions, ...writeActions],
};
