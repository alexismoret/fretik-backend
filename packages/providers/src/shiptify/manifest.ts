import type {
  ParamSpec,
  ProviderManifest,
} from "@fretik/shared/external-apps/manifest-schema";

/**
 * One pickup or delivery stop. Shared by every `create_shipment_request*`
 * action (shipper + carrier, main + draft).
 *
 * Shiptify's OpenAPI uses `oneOf` with three branches (inline,
 * by_internal_ref, by_address_id). Our manifest framework can't express
 * `oneOf`, so we declare every possible field and document the three
 * valid combinations in the description. Server-side validation is the
 * source of truth — what matters for our agent is that all declared
 * fields are PRESERVED by `validateActionArgs` (Zod strips unknown
 * sub-keys when an `object` ParamSpec has `fields: {}` — that's the bug
 * we are fixing here).
 *
 * `date_from` is REQUIRED for the non-draft endpoints; the description
 * tells the agent. Marking it optional at the schema level lets the
 * draft endpoints accept stops without dates.
 */
const addressStop: ParamSpec = {
  type: "object",
  description:
    "One pickup/delivery stop. Pick ONE of three shapes:\n" +
    " (a) Recommended — by location id: `{ address_id, date_from, date_to?, time_from?, time_to? }`. Call list_locations() to resolve address_id; if no match, call create_location() first.\n" +
    " (b) By third-party reference: `{ internal_ref, date_from, ... }`. The reference must match an existing location in the address book.\n" +
    " (c) Inline (last resort): `{ address_1, city, country, zipcode, date_from, name?, address_2?, state?, recipient_name?, type?, email?, phone_number?, instructions? }`. Inline addresses are validated strictly on the carrier endpoint — prefer create_location + address_id whenever possible.\n" +
    "`date_from` is REQUIRED on every shape for the main endpoints (omit only on the *_draft variants).",
  fields: {
    address_id: {
      type: "integer",
      optional: true,
      description: "Location id from list_locations() — recommended shape",
    },
    internal_ref: {
      type: "string",
      optional: true,
      description: "Third-party reference matching an existing location",
    },
    address_1: {
      type: "string",
      optional: true,
      description: "Street address (line 1) — required when inline",
    },
    address_2: { type: "string", optional: true },
    city: {
      type: "string",
      optional: true,
      description: "Required when inline",
    },
    state: { type: "string", optional: true },
    zipcode: {
      type: "string",
      optional: true,
      description: "Required when inline",
    },
    country: {
      type: "string",
      optional: true,
      description:
        "ISO 3166-1 alpha-2 (e.g. FR, BE, US) — required when inline",
    },
    name: {
      type: "string",
      optional: true,
      description: "Location name shown in the Shiptify address book",
    },
    recipient_name: { type: "string", optional: true },
    type: {
      type: "enum",
      values: [
        "store",
        "final_customer",
        "warehouse",
        "factory",
        "port",
        "airport",
        "head_office",
        "other",
      ],
      optional: true,
      description:
        "Location type. Use `final_customer` for delivery sites, `factory` for supplier sites; `other` as a safe fallback.",
    },
    email: { type: "email", optional: true },
    phone_number: { type: "string", optional: true },
    instructions: {
      type: "string",
      optional: true,
      excludeFromHash: true,
      description: "Free-text dock / driver instructions",
    },
    skip_zipcode_validation: { type: "boolean", optional: true },
    date_from: {
      type: "string",
      optional: true,
      description:
        "Stop date (YYYY-MM-DD). REQUIRED for create_shipment_request and galaxy_create_carrier_shipment_request; optional on the *_draft variants.",
    },
    date_to: { type: "string", optional: true, description: "YYYY-MM-DD" },
    time_from: {
      type: "string",
      optional: true,
      description: "HH:MM in UTC",
    },
    time_to: {
      type: "string",
      optional: true,
      description: "HH:MM in UTC",
    },
  },
};

/**
 * One cargo line. Shared by every `create_shipment_request*` action.
 * Required: `type_id` (lookup via `list_content_types()`) + `quantity`.
 * No `m3` / `volume_m3` per line — Shiptify silently drops unknown
 * fields and the cargo line ends up incomplete on the wire. Aggregate
 * volume to the top-level `total_volume` instead.
 */
const cargoLine: ParamSpec = {
  type: "object",
  description:
    "One cargo line. Required: `type_id` (from list_content_types() — choose by name + mode flags) and `quantity`. " +
    "Common optional fields: `weight` (per unit, account's weight_unit), `height`/`length`/`width` (per unit, account's dimension_unit), `comment`, `internal_ref`. " +
    "Use `is_dangerous: true` + `dangerous_goods_description` for ADR/IMO/IATA cargo. " +
    "Unknown fields (e.g. `m3`, `volume_m3`) are silently dropped — aggregate volume to top-level `total_volume` instead.",
  fields: {
    type_id: {
      type: "integer",
      description: "Content type id from list_content_types()",
    },
    quantity: {
      type: "integer",
      description: "Number of units (pallets, containers, …)",
    },
    weight: {
      type: "number",
      optional: true,
      description: "Per-unit weight (account's weight_unit, usually kg)",
    },
    height: {
      type: "number",
      optional: true,
      description: "Per-unit height (account's dimension_unit, usually cm)",
    },
    length: { type: "number", optional: true },
    width: { type: "number", optional: true },
    comment: { type: "string", optional: true, excludeFromHash: true },
    internal_ref: {
      type: "string",
      optional: true,
      description: "Third-party reference for this cargo line",
    },
    product_type_id: { type: "integer", optional: true },
    spec_id: {
      type: "integer",
      optional: true,
      description: "Content specificities id",
    },
    is_stacked: { type: "boolean", optional: true },
    is_dangerous: { type: "boolean", optional: true },
    freight_unit_key: { type: "string", optional: true },
    onu_code: {
      type: "string",
      optional: true,
      description: "Dangerous goods ONU code (when is_dangerous)",
    },
    unit: { type: "string", optional: true },
    is_controlled_temperature: { type: "boolean", optional: true },
  },
};

/**
 * Shiptify (TMS) provider manifest — covers BOTH account roles Shiptify
 * supports (`/accounts/` returns `type: "shipper" | "carrier"`):
 *  - **Shipper** accounts use the unprefixed actions (`create_shipment_request`,
 *    `confirm_shipment_pickup`, …) that hit `/shipment-requests/`,
 *    `/shipments/`, `/tracking-points/`.
 *  - **Carrier** accounts use the `galaxy_*` actions that hit
 *    `/galaxy/carrier/…`, `/galaxy/shipments/…`, `/galaxy/tracking-points/…`
 *    — Shiptify's carrier-side namespace. Calling a shipper action on a
 *    carrier connection returns `403 "User is not shipper"` (and vice-versa).
 *  - **Lookups** (`list_locations`, `create_location`, `list_shipment_modes`,
 *    `list_carriers`, `get_attachment_download_url`) are shared.
 *
 * The active role is stored in `connection.options.account_type`, declared
 * below as a `connectionOptions` field with `exposeToAgent: true`, and is
 * surfaced to the agent through the system prompt's `<external_apps>` block.
 * The agent reads it and picks the matching action prefix — see
 * `guidance.md` for the routing rule.
 *
 * Transport: `http-direct` — Shiptify is NOT in Nango's catalog, so we
 * collect the API key + optional account id via our own descriptor-driven
 * form and fire `fetch()` ourselves. Source-of-truth swagger spec is
 * committed at `openapi.json` alongside this file (~224 endpoints).
 *
 * Out-of-scope today (intentional, low-ROI for the agent): warehouse / dock
 * modules (`/slots`, `/visits`, `/dock-orders`, `/transport-requests`,
 * `/freight-units`, `/sscc`, `/orders/*`), metadata-prototype writes, all
 * financial endpoints (`/invoices`, `/financial-groups`, `/customs-invoices`,
 * `/price-details`). Re-evaluate per customer request.
 *
 * Auth model:
 *  - `credentials.api_key` → `Authorization: <api_key>` header, verbatim.
 *    Shiptify's tokens carry their own scheme prefix; we never add one.
 *  - `connection_config.account_id` → `X-Account-ID` header, OPTIONAL.
 *  - `connection.options.account_type` → `shipper` | `carrier`, auto-filled
 *    from `/accounts/` at connect time and exposed to the agent.
 *
 * `X-Account-ID` is a NARROWING filter, not a tenant key — this is the
 * single most load-bearing fact about connecting Shiptify. A token already
 * carries its own scope: for a token issued on a carrier group it is every
 * account of that group. Sending the header restricts the call to ONE
 * account, and Shiptify answers `403 "Account is not available"` for any
 * account the token may not act on — measured: on a group token listing 18
 * accounts, 17 of them 403 and the 18th silently hides the other 17's
 * shipments. Omitted (the default), the token keeps its natural scope,
 * which is what almost every connection wants. `dynamic-options.ts` probes
 * each account so the form can only ever offer one that works.
 */
export const shiptifyManifest: ProviderManifest = {
  key: "shiptify",
  displayName: "Shiptify",
  description:
    "Shiptify — manage transport shipments, addresses, and related records on the connected Shiptify TMS account (shipper or carrier).",
  // Nango integration key — points at a `private-api-key` template, used
  // purely as encrypted credential storage. No proxy, no scopes.
  nangoProviderConfigKey: "shiptify",
  // Local asset — `AppIcon.vue` renders it as `<img>` (no tint applied).
  icon: "/app-icons/shiptify.png",
  iconColor: "#27BEF5",
  categories: ["industry", "tms"],
  scopes: [],
  transport: {
    kind: "http-direct",
    baseUrl: "https://api.shiptify.com",
    auth: {
      kind: "header",
      name: "Authorization",
      source: "credentials.api_key",
    },
    extraHeaders: [
      // Optional on purpose — see the auth-model note above. Omitted, the
      // token keeps its own scope; set, it narrows every call to one account.
      {
        name: "X-Account-ID",
        source: "connection_config.account_id",
        optional: true,
      },
    ],
  },

  connectionOptions: {
    fields: [
      {
        // Shiptify account role — `/accounts/` returns `type: shipper |
        // carrier` per row. Auto-filled by the modal from the Account
        // field's `meta.account_type`, which `dynamic-options.ts` sets on
        // every entry INCLUDING the "every account" one (it reports the
        // role shared by the accounts the token reaches). The default
        // below only shows before the dropdown has populated. The agent
        // reads this value from the system prompt's <external_apps> block
        // and routes to the matching action prefix — `galaxy_*` for
        // carrier, unprefixed for shipper.
        key: "account_type",
        labelKey:
          "settings.externalApps.providers.shiptify.options.account_type.label",
        helpKey:
          "settings.externalApps.providers.shiptify.options.account_type.help",
        kind: "select",
        required: true,
        default: "shipper",
        options: [
          {
            value: "shipper",
            labelKey:
              "settings.externalApps.providers.shiptify.options.account_type.shipper",
            descriptionKey:
              "settings.externalApps.providers.shiptify.options.account_type.shipperHelp",
          },
          {
            value: "carrier",
            labelKey:
              "settings.externalApps.providers.shiptify.options.account_type.carrier",
            descriptionKey:
              "settings.externalApps.providers.shiptify.options.account_type.carrierHelp",
          },
        ],
        exposeToAgent: true,
      },
    ],
  },

  credentialsForm: {
    fields: [
      {
        key: "api_key",
        // Nango's `private-api-key` template expects `credentials.apiKey`
        // in camelCase. The frontend renames at connect time and the
        // backend `normalizeNangoCredentials` reverses it when reading
        // the stored connection, so every backend consumer keeps reading
        // the canonical `credentials.api_key`.
        nangoKey: "apiKey",
        target: "credentials",
        kind: "password",
        required: true,
        labelKey:
          "settings.externalApps.providers.shiptify.fields.api_key.label",
        helpKey: "settings.externalApps.providers.shiptify.fields.api_key.help",
      },
      {
        // Resolved from the API key via `listAccounts` (see
        // `dynamic-options.ts`), which probes each account and offers only
        // the ones the token can actually act on, behind an "every account
        // this key can reach" entry.
        //
        // OPTIONAL: the empty value is the recommended one — it sends no
        // `X-Account-ID` and leaves the token at its natural scope. Picking
        // an account is how a user with a multi-account token restricts a
        // connection to one of them.
        key: "account_id",
        target: "connection_config",
        kind: "dynamic-select",
        required: false,
        dependsOn: ["api_key"],
        optionsHandler: "listAccounts",
        labelKey:
          "settings.externalApps.providers.shiptify.fields.account_id.label",
        helpKey:
          "settings.externalApps.providers.shiptify.fields.account_id.help",
      },
    ],
    testConnection: { supported: true },
  },

  types: {
    /** Compact shipment-request entry — list / get returns these. */
    ShipmentRequest: {
      id: { type: "integer" },
      internal_ref: {
        type: "string",
        optional: true,
        description: "Third-party reference set by the caller",
      },
      name: { type: "string" },
      status: { type: "string" },
      shipment_mode_id: { type: "integer", optional: true },
      reply_before: { type: "datetime", optional: true },
      total_weight: { type: "number", optional: true },
      total_volume: { type: "number", optional: true },
      total_linear_meters: { type: "number", optional: true },
      comment: { type: "string", optional: true },
      created_at: { type: "datetime", optional: true },
    },
    /**
     * A shipment. ONE shape for both roles: `/shipments/*` (shipper view)
     * and `/galaxy*` (carrier view) return the same object — verified
     * field-by-field against the live API — so there is no reason to make
     * the agent learn two models. `weight` / `cost` / `goods_value` are
     * free-text decimals in Shiptify's own payload; the `total_*` fields
     * are the numeric ones.
     */
    Shipment: {
      id: { type: "integer" },
      code: {
        type: "string",
        optional: true,
        description: "Shiptify shipment code",
      },
      status: { type: "string", optional: true },
      tracking_code: { type: "string", optional: true },
      name: { type: "string", optional: true },
      internal_ref: {
        type: "string",
        optional: true,
        description: "Third-party reference set by the caller",
      },
      other_reference: {
        type: "string",
        optional: true,
        description: "Second third-party reference (project / order name)",
      },
      shipper_id: { type: "integer", optional: true },
      carrier_id: { type: "integer", optional: true },
      shipper_name: {
        type: "string",
        optional: true,
        description: "Flattened from the nested shipper row",
      },
      sh_request_id: {
        type: "integer",
        optional: true,
        description: "Parent shipment-request id",
      },
      quote_request_id: { type: "integer", optional: true },
      total_weight: { type: "number", optional: true },
      total_volume: { type: "number", optional: true },
      total_linear_meters: { type: "number", optional: true },
      weight: { type: "string", optional: true, description: "Free-text" },
      cost: {
        type: "string",
        optional: true,
        description: "Free-text decimal, account currency",
      },
      goods_value: { type: "string", optional: true },
      co2_amount: { type: "number", optional: true },
      date: { type: "string", optional: true },
      estimated_departure_time: { type: "datetime", optional: true },
      real_departure_time: { type: "datetime", optional: true },
      estimated_arrival_time: { type: "datetime", optional: true },
      real_arrival_time: { type: "datetime", optional: true },
      created_at: { type: "datetime", optional: true },
      archived_carrier: { type: "boolean", optional: true },
      archived_shipper: { type: "boolean", optional: true },
      shipment_mode: {
        type: "string",
        optional: true,
        description: "Resolved mode label (e.g. road, sea, air)",
      },
      shiptify_private_link: {
        type: "string",
        optional: true,
        description: "Internal Shiptify link to the shipment dashboard",
      },
      shiptify_public_link: {
        type: "string",
        optional: true,
        description: "Public tracking link sharable with the consignee",
      },
    },
    /** One stop / event along a shipment's journey. */
    TrackingPoint: {
      id: { type: "integer" },
      shipment_id: { type: "integer", optional: true },
      type: {
        type: "string",
        optional: true,
        description: "Point type (departure, arrival, transit, …)",
      },
      code: { type: "string", optional: true },
      position: {
        type: "integer",
        optional: true,
        description: "Order along the journey, 0-based",
      },
      address_id: { type: "integer", optional: true },
      planned_date: { type: "datetime", optional: true },
      planned_time: { type: "string", optional: true, description: "HH:mm" },
      real_date: { type: "datetime", optional: true },
      real_time: { type: "string", optional: true, description: "HH:mm" },
      incident: { type: "string", optional: true },
      comment: { type: "string", optional: true },
    },
    /** File attached to a shipment / shipment request. */
    Attachment: {
      id: { type: "integer" },
      name: { type: "string" },
      type: {
        type: "string",
        optional: true,
        description: "Document type (invoice, bill_of_lading, cmr, …)",
      },
      status: {
        type: "string",
        optional: true,
        description: "`active` or `deactivated`",
      },
    },
    /** Address book entry (origin / destination of shipment requests). */
    Location: {
      id: { type: "integer" },
      name: { type: "string" },
      internal_ref: { type: "string", optional: true },
      recipient_name: { type: "string", optional: true },
      address_1: { type: "string", optional: true },
      address_2: { type: "string", optional: true },
      city: { type: "string", optional: true },
      state: { type: "string", optional: true },
      zipcode: { type: "string", optional: true },
      country: {
        type: "string",
        optional: true,
        description: "ISO 3166-1 alpha-2 country code",
      },
      type: {
        type: "string",
        optional: true,
        description: "Location type (warehouse, customer, …)",
      },
    },
    Carrier: {
      id: { type: "integer" },
      name: { type: "string" },
      code: { type: "string", optional: true },
      scac: { type: "string", optional: true },
      internal_ref: { type: "string", optional: true },
    },
    ShipmentMode: {
      id: { type: "integer" },
      name: {
        type: "string",
        description: "Mode label (e.g. road, sea, air, rail, courier)",
      },
    },
    /**
     * Cargo content type — what `list_content_types` returns. The `id` is
     * the value the agent passes as `type_id` on each `contents[i]` line
     * of any create_shipment_request action. Mode flags (`for_sea`,
     * `for_road`, …) let the agent filter by the booking's mode so the
     * line is dimensionally compatible.
     *
     * Shiptify ships the four dimensional fields as free text (`""` when
     * unset); the `contentTypeList` mapper coerces them to numbers or null
     * so the agent can compare them without parsing.
     */
    ContentType: {
      id: { type: "integer" },
      name: {
        type: "string",
        description: "Display name (e.g. 'Pallet 80x120', '40 HC')",
      },
      length: { type: "number", optional: true },
      width: { type: "number", optional: true },
      height: { type: "number", optional: true },
      weight: { type: "number", optional: true },
      dimension_unit: {
        type: "string",
        optional: true,
        description: "cm | in",
      },
      weight_unit: { type: "string", optional: true, description: "kg | lb" },
      is_container: { type: "boolean", optional: true },
      iso_container_type: {
        type: "string",
        optional: true,
        description: "ISO container type (e.g. '40HC', '20GP')",
      },
      for_road: { type: "boolean", optional: true },
      for_sea: { type: "boolean", optional: true },
      for_air: { type: "boolean", optional: true },
      for_rail: { type: "boolean", optional: true },
      for_express: { type: "boolean", optional: true },
      for_groupage: { type: "boolean", optional: true },
      for_courier: { type: "boolean", optional: true },
      for_air_sea: { type: "boolean", optional: true },
      for_ro_ro: { type: "boolean", optional: true },
      for_river: { type: "boolean", optional: true },
    },
    /** Generic `{ id?, internal_ref? }` returned by create endpoints. */
    WriteResult: {
      id: { type: "integer", optional: true },
      internal_ref: { type: "string", optional: true },
      successful: { type: "boolean", optional: true },
    },
    /** Wraps the plain string returned by /attachments/{id}/download. */
    AttachmentDownload: {
      url: {
        type: "string",
        description: "Signed URL to GET the attachment binary (expires fast)",
      },
    },

    // ─── Carrier-side shapes ─────────────────────────────────────────
    //
    // Galaxy is Shiptify's carrier-side namespace and the `galaxy_*`
    // actions below are how a carrier connection reads and writes. It has
    // no shipment shape of its own: `/shipments/{id}` and
    // `/galaxy/shipments/{id}` return the SAME 46 fields with the same
    // values for the same shipment (verified against the live API), so
    // both roles share the `Shipment` type above. The separate
    // `GalaxyShipment` this replaces declared 21 of those 46 and silently
    // dropped `total_weight`, `total_volume`, `created_at` and both
    // tracking links from every carrier read.

    /**
     * One quote request a carrier received — the RFQ inbox row returned by
     * `list_quote_requests`. It embeds the price lines the carrier is
     * asked to fill (`price_details`) and the parent shipment request, so
     * answering an RFQ needs no second read.
     */
    QuoteRequest: {
      id: { type: "integer" },
      sh_request_id: {
        type: "integer",
        optional: true,
        description: "Parent shipment-request id",
      },
      carrier_id: { type: "integer", optional: true },
      status: {
        type: "string",
        optional: true,
        description: "new | canceled | …",
      },
      is_read: { type: "boolean", optional: true },
      reply_before: {
        type: "datetime",
        optional: true,
        description: "Deadline to answer the RFQ",
      },
      shipment_mode_id: { type: "integer", optional: true },
      cost: {
        type: "string",
        optional: true,
        description: "Free-text decimal — 0.000 until the carrier prices it",
      },
      currency_code: { type: "string", optional: true },
      date_departure: { type: "datetime", optional: true },
      date_arrival: { type: "datetime", optional: true },
      shipment_request: {
        type: "object",
        optional: true,
        description: "The shipper's request this quote answers",
        fields: {
          id: { type: "integer", optional: true },
          name: { type: "string", optional: true },
          pre_awarded: { type: "boolean", optional: true },
        },
      },
      price_details: {
        type: "array",
        optional: true,
        description: "Price lines — null `price` means the line is unquoted",
        items: {
          type: "object",
          fields: {
            id: { type: "integer", optional: true },
            name: {
              type: "string",
              optional: true,
              description: "Line label (Freight, Admin, …)",
            },
            price: {
              type: "string",
              optional: true,
              description:
                "Free-text decimal like every Shiptify amount — parse before computing",
            },
            currency_code: { type: "string", optional: true },
          },
        },
      },
    },

    /** Active shipper relationship on a carrier account. */
    GalaxyShipper: {
      id: { type: "integer" },
      name: { type: "string" },
      account_id: {
        type: "integer",
        optional: true,
        description: "Shiptify account id of the shipper",
      },
    },
  },

  actions: [
    // ─────────────────── Shipment requests — read ───────────────────
    {
      name: "list_shipment_requests",
      kind: "read",
      summary: "List shipment requests on the account",
      endpoint: { method: "GET", path: "/shipment-requests/" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
      },
      returns: { list: "ShipmentRequest" },
    },
    {
      name: "get_shipment_request",
      kind: "read",
      summary: "Fetch one shipment request by id",
      endpoint: { method: "GET", path: "/shipment-requests/{id}" },
      params: {
        id: { type: "integer", in: "path" },
      },
      returns: { ref: "ShipmentRequest" },
    },
    {
      name: "list_shipment_request_attachments",
      kind: "read",
      summary: "List attachments on a shipment request",
      endpoint: {
        method: "GET",
        path: "/shipment-requests/{id}/attachments",
      },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "Attachment" },
    },
    {
      name: "list_shipment_request_shipments",
      kind: "read",
      summary: "List the shipments produced by a shipment request",
      endpoint: { method: "GET", path: "/shipment-requests/{id}/shipments" },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "Shipment" },
      response: "shipmentList",
    },

    // ─────────────────── Shipment requests — write ───────────────────
    {
      name: "create_shipment_request",
      kind: "write",
      summary: "Create a new shipment request (booking)",
      endpoint: { method: "POST", path: "/shipment-requests/" },
      request: "sanitiseCreateShipmentRequest",
      params: {
        name: {
          type: "string",
          description: "Free-text booking name shown in lists",
        },
        shipment_mode_id: {
          type: "integer",
          description:
            "Mode id from list_shipment_modes() — road / sea / air / rail / …",
        },
        reply_before: {
          type: "string",
          description:
            "Deadline for the carrier to respond — format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'. A request mapper strips any trailing Z / +HH:MM as a safety net, but prefer sending the no-TZ form directly.",
        },
        from_addresses: {
          type: "array",
          description:
            "Pickup stop(s). See item description for the three accepted shapes; `date_from` (YYYY-MM-DD) is REQUIRED on each.",
          items: addressStop,
        },
        dest_addresses: {
          type: "array",
          description:
            "Delivery stop(s) — same item shape as from_addresses; `date_from` REQUIRED.",
          items: addressStop,
        },
        accounting_entity_id: { type: "integer", optional: true },
        carrier_id: {
          type: "integer",
          optional: true,
          description:
            "Carrier id from list_carriers() when booking with a specific carrier",
        },
        carrier_ids: {
          type: "array",
          optional: true,
          items: { type: "integer" },
          description: "Several carriers to RFQ in parallel",
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        internal_note: {
          type: "string",
          optional: true,
          excludeFromHash: true,
          description: "Note visible only inside the account",
        },
        internal_ref: {
          type: "string",
          optional: true,
          description: "Third-party reference (your TMS / ERP id)",
        },
        internal_name: {
          type: "string",
          optional: true,
          description: "Third-party booking name (your internal label)",
        },
        total_volume: { type: "number", optional: true },
        total_weight: { type: "number", optional: true },
        total_linear_meters: { type: "number", optional: true },
        measurement_system: {
          type: "enum",
          values: ["metric", "imperial"],
          optional: true,
          description: "Defaults to the account preference",
        },
        contents: {
          type: "array",
          optional: true,
          description:
            "Cargo lines. Each item requires `type_id` (from list_content_types()) and `quantity`. See item description for optional fields and the unknown-fields warning.",
          items: cargoLine,
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "create_shipment_request_draft",
      kind: "write",
      summary: "Create a draft shipment request (status: draft)",
      endpoint: { method: "POST", path: "/shipment-requests/draft" },
      request: "sanitiseCreateShipmentRequest",
      params: {
        name: { type: "string" },
        shipment_mode_id: { type: "integer", optional: true },
        reply_before: {
          type: "string",
          optional: true,
          description:
            "Format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'.",
        },
        from_addresses: {
          type: "array",
          optional: true,
          items: addressStop,
          description:
            "Same item shape as create_shipment_request. On drafts, `date_from` is OPTIONAL (omit when not yet known).",
        },
        dest_addresses: {
          type: "array",
          optional: true,
          items: addressStop,
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        internal_ref: { type: "string", optional: true },
        internal_name: { type: "string", optional: true },
        total_volume: { type: "number", optional: true },
        total_weight: { type: "number", optional: true },
        contents: {
          type: "array",
          optional: true,
          items: cargoLine,
          description:
            "Cargo lines (same item shape as create_shipment_request).",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "update_shipment_request",
      kind: "write",
      summary: "Update fields of a shipment request",
      endpoint: { method: "PATCH", path: "/shipment-requests/{id}" },
      params: {
        id: { type: "integer", in: "path" },
        name: { type: "string", optional: true },
        accounting_entity_id: { type: "integer", optional: true },
        comment: { type: "string", optional: true, excludeFromHash: true },
        internal_note: {
          type: "string",
          optional: true,
          excludeFromHash: true,
        },
        internal_ref: { type: "string", optional: true },
        internal_name: { type: "string", optional: true },
        total_volume: { type: "number", optional: true },
        total_weight: { type: "number", optional: true },
        total_linear_meters: { type: "number", optional: true },
        measurement_system: {
          type: "enum",
          values: ["metric", "imperial"],
          optional: true,
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "cancel_shipment_request",
      kind: "write",
      summary: "Cancel a shipment request",
      endpoint: { method: "PUT", path: "/shipment-requests/{id}/cancel" },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "upload_shipment_request_attachment",
      kind: "write",
      summary: "Upload one or several files onto a shipment request",
      endpoint: { method: "POST", path: "/shipment-requests/{id}/upload" },
      params: {
        id: { type: "integer", in: "path" },
        carrier_id: {
          type: "integer",
          optional: true,
          description: "Restrict visibility to a specific carrier (RFQ stage)",
        },
        attachments: {
          type: "array",
          excludeFromHash: true,
          description:
            "Files to upload — each item `{ fileName, documentType, base64Data | url, accessType?, save? }`. `documentType` is one of: invoice, order, customs, packing_list, bill_of_lading, cmr, cmr_at_departure, signed_cmr_at_arrival, proof_of_delivery, awb, msds, claim, other (full list in Shiptify docs).",
          items: { type: "object", fields: {} },
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "send_shipment_request_message",
      kind: "write",
      summary: "Post a message in the booking chat of a shipment request",
      endpoint: { method: "POST", path: "/shipment-requests/{id}/message" },
      params: {
        id: { type: "integer", in: "path" },
        message: {
          type: "string",
          excludeFromHash: true,
          description: "Plain-text message body",
        },
        carrier_id: {
          type: "integer",
          optional: true,
          description: "Target carrier when the request is RFQ-ing several",
        },
        sender_name: { type: "string", optional: true },
        sender_email: { type: "email", optional: true },
      },
      returns: { ref: "WriteResult" },
    },

    // ─────────────────── Shipments — read ───────────────────
    {
      name: "list_shipments",
      kind: "read",
      summary:
        "List shipments — the shipper's main tracking hub, with strong filters",
      // Answers for a carrier too, but only for the account the token was
      // issued on. A carrier wanting its whole group calls
      // galaxy_list_shipments.
      endpoint: { method: "GET", path: "/shipments/" },
      response: "shipmentList",
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
        created_date_from: {
          type: "datetime",
          optional: true,
          description: "Filter by creation date (YYYY-MM-DD)",
        },
        created_date_to: { type: "datetime", optional: true },
        departure_date_min: { type: "datetime", optional: true },
        departure_date_max: { type: "datetime", optional: true },
        arrival_date_min: { type: "datetime", optional: true },
        arrival_date_max: { type: "datetime", optional: true },
        sh_request_id: {
          type: "integer",
          optional: true,
          description: "Filter by parent shipment-request id",
        },
        sr_internal_ref: {
          type: "string",
          optional: true,
          description: "Filter by parent shipment-request internal_ref",
        },
        from_address_id: { type: "integer", optional: true },
        dest_address_id: { type: "integer", optional: true },
        from_address_internal_ref: { type: "string", optional: true },
        dest_address_internal_ref: { type: "string", optional: true },
        shipper_id: { type: "integer", optional: true },
      },
      returns: { list: "Shipment" },
    },
    {
      name: "get_shipment",
      kind: "read",
      summary: "Fetch one shipment by id",
      endpoint: { method: "GET", path: "/shipments/{id}" },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "Shipment" },
      response: "shipment",
    },
    {
      name: "list_tracking_points",
      kind: "read",
      summary: "List the tracking points (stops / events) of a shipment",
      endpoint: { method: "GET", path: "/shipments/{id}/tracking-points" },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "TrackingPoint" },
    },
    {
      name: "list_shipment_attachments",
      kind: "read",
      summary: "List attachments on a shipment",
      endpoint: { method: "GET", path: "/shipments/{id}/attachments" },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "Attachment" },
    },
    {
      name: "get_attachment_download_url",
      kind: "read",
      summary: "Get a signed URL to download one attachment",
      endpoint: { method: "GET", path: "/attachments/{id}/download" },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "AttachmentDownload" },
      response: "attachmentDownload",
    },

    // ─────────────────── Shipments — write ───────────────────
    {
      name: "confirm_shipment_pickup",
      kind: "write",
      summary: "Confirm pickup of a shipment (creates the actual pickup point)",
      endpoint: { method: "PUT", path: "/shipments/{id}/pickup/confirm" },
      params: {
        id: { type: "integer", in: "path" },
        date: {
          type: "string",
          description: "Pickup date — YYYY-MM-DD",
        },
        time: {
          type: "string",
          optional: true,
          description: "Pickup time — HH:mm",
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        incident: {
          type: "string",
          optional: true,
          description:
            "Incident label (e.g. 'Customs clearance', 'Strike', 'Truck incident', 'Waiting at pick up place'). Omit when pickup is on time.",
        },
        cause_id: {
          type: "integer",
          optional: true,
          description: "Cause id from /dictionary/causes when applicable",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "confirm_shipment_delivery",
      kind: "write",
      summary: "Confirm delivery of a shipment",
      endpoint: { method: "PUT", path: "/shipments/{id}/delivery/confirm" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", description: "Delivery date — YYYY-MM-DD" },
        time: {
          type: "string",
          optional: true,
          description: "Delivery time — HH:mm",
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        incident: { type: "string", optional: true },
        cause_id: { type: "integer", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "replan_shipment_pickup",
      kind: "write",
      summary: "Replan pickup of a shipment (new date / time)",
      endpoint: { method: "PUT", path: "/shipments/{id}/pickup/replan" },
      params: {
        id: { type: "integer", in: "path" },
        date: {
          type: "string",
          optional: true,
          description: "New pickup date — YYYY-MM-DD",
        },
        time: { type: "string", optional: true, description: "HH:mm" },
        comment: { type: "string", optional: true, excludeFromHash: true },
        reason: {
          type: "string",
          optional: true,
          description: "Short reason for the replan",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "replan_shipment_delivery",
      kind: "write",
      summary: "Replan delivery of a shipment",
      endpoint: { method: "PUT", path: "/shipments/{id}/delivery/replan" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true, description: "YYYY-MM-DD" },
        time: { type: "string", optional: true, description: "HH:mm" },
        comment: { type: "string", optional: true, excludeFromHash: true },
        reason: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "upload_shipment_attachment",
      kind: "write",
      summary: "Upload one or several files onto a shipment",
      endpoint: { method: "POST", path: "/shipments/{id}/upload" },
      params: {
        id: { type: "integer", in: "path" },
        attachments: {
          type: "array",
          excludeFromHash: true,
          description:
            "Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`. `documentType` examples: proof_of_delivery, cmr, signed_cmr_at_arrival, invoice, awb, customs, claim, other.",
          items: { type: "object", fields: {} },
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "send_shipment_message",
      kind: "write",
      summary: "Post a message in the tracking chat of a shipment",
      endpoint: { method: "POST", path: "/shipments/{id}/message" },
      params: {
        id: { type: "integer", in: "path" },
        message: {
          type: "string",
          excludeFromHash: true,
          description: "Plain-text message body",
        },
        sender_name: { type: "string", optional: true },
        sender_email: { type: "email", optional: true },
      },
      returns: { ref: "WriteResult" },
    },

    // ─────────────────── Lookups (read-only references) ───────────────────
    {
      name: "list_locations",
      kind: "read",
      summary:
        "List address-book locations — call before creating a SR to pick from/dest address ids",
      endpoint: { method: "GET", path: "/locations" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
        q: {
          type: "string",
          optional: true,
          description:
            "Free-text search across name / address / city / zipcode / internal_ref",
        },
        internal_ref: {
          type: "string",
          optional: true,
          description: "Exact match on third-party reference",
        },
      },
      returns: { list: "Location" },
    },
    {
      name: "create_location",
      kind: "write",
      summary:
        "Create a new address-book location — use ONLY when list_locations returned no match",
      endpoint: { method: "POST", path: "/locations" },
      params: {
        name: {
          type: "string",
          description: "Short label shown in the Shiptify address book",
        },
        address_1: {
          type: "string",
          description: "Street address (line 1)",
        },
        city: { type: "string" },
        zipcode: { type: "string" },
        country: {
          type: "string",
          description: "ISO 3166-1 alpha-2 country code (e.g. FR, BE, DE)",
        },
        type: {
          type: "enum",
          values: [
            "store",
            "final_customer",
            "warehouse",
            "factory",
            "port",
            "airport",
            "head_office",
            "other",
          ],
          optional: true,
          description:
            "Location type — Shiptify's closed set. Use `final_customer` for end-customer / delivery sites and `factory` for manufacturing / supplier sites; `other` is the safe fallback.",
        },
        address_2: { type: "string", optional: true },
        state: { type: "string", optional: true },
        recipient_name: { type: "string", optional: true },
        company_name: { type: "string", optional: true },
        email: { type: "email", optional: true },
        phone_number: { type: "string", optional: true },
        instructions: {
          type: "string",
          optional: true,
          excludeFromHash: true,
          description: "Free-text dock / driver instructions",
        },
        internal_ref: {
          type: "string",
          optional: true,
          description: "Third-party reference (your TMS / ERP id)",
        },
        locode: {
          type: "string",
          optional: true,
          description: "UN/LOCODE (5 letters) for ports / airports",
        },
        contact: {
          type: "object",
          optional: true,
          description:
            "Main contact at the site — `{ first_name, last_name, email, phone_number, civility? }`",
          fields: {
            first_name: { type: "string", optional: true },
            last_name: { type: "string", optional: true },
            email: { type: "email", optional: true },
            phone_number: { type: "string", optional: true },
          },
        },
      },
      returns: { ref: "Location" },
    },
    {
      name: "list_carriers",
      kind: "read",
      summary: "List active carriers on the account",
      endpoint: { method: "GET", path: "/carriers/active" },
      params: {
        internal_ref: {
          type: "string",
          optional: true,
          description: "Exact match on third-party reference",
        },
      },
      returns: { list: "Carrier" },
    },
    {
      name: "list_shipment_modes",
      kind: "read",
      summary:
        "List shipment modes (road / sea / air / …) — call before create_shipment_request",
      endpoint: { method: "GET", path: "/dictionary/shipment-modes" },
      params: {},
      returns: { list: "ShipmentMode" },
    },
    {
      name: "list_content_types",
      kind: "read",
      summary:
        "List cargo content types — call before any create_shipment_request* to resolve `type_id` on each cargo line",
      // `/content-types/active` is the account's curated subset but answers
      // 403 "User is not shipper" on a carrier token, which left carriers
      // with no way to resolve the `type_id` their own create action
      // requires. `/content-types` is the full catalogue and answers for
      // both roles — the only variant that never blocks a connection. It
      // returns ~1 400 rows: the mapper trims each to the declared fields,
      // and the agent filters in Python (see guidance.md).
      endpoint: { method: "GET", path: "/content-types" },
      response: "contentTypeList",
      params: {},
      returns: { list: "ContentType" },
    },

    // ════════════════════ GALAXY — carrier-side ════════════════════
    //
    // Use these actions ONLY when the connection's `account_type ===
    // "carrier"`. Shipper accounts get 403 "User is not carrier" here.
    // See guidance.md for the routing rule.

    // ─── Carrier RFQ inbox — read ──────────────────────────────────
    {
      name: "list_quote_requests",
      kind: "read",
      summary: "List the quote requests received as a carrier (the RFQ inbox)",
      // Not `galaxy_`-prefixed: the path is not under /galaxy, and this is
      // the ONE read that answers the carrier's inbox question. It replaces
      // `galaxy_list_carrier_shipment_requests` and
      // `galaxy_list_ready_to_book`, both of which addressed
      // /galaxy/carrier/shipment-requests[/ready_to_book] with GET — routes
      // that exist only as POST (they CREATE a request) and so returned a
      // router 404 on every call.
      endpoint: { method: "GET", path: "/quote-requests/" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
      },
      returns: { list: "QuoteRequest" },
    },

    // ─── Galaxy shipment requests — write ──────────────────────────
    {
      name: "galaxy_create_carrier_shipment_request",
      kind: "write",
      summary: "Create a carrier-initiated shipment request (spot booking)",
      endpoint: { method: "POST", path: "/galaxy/carrier/shipment-requests" },
      request: "sanitiseCreateShipmentRequest",
      params: {
        name: { type: "string" },
        shipment_mode_id: {
          type: "integer",
          description: "Mode id from list_shipment_modes()",
        },
        reply_before: {
          type: "string",
          description:
            "Deadline for the shipper to respond — format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'. A request mapper strips any trailing Z / +HH:MM as a safety net.",
        },
        from_addresses: {
          type: "array",
          description:
            "Pickup stop(s). See item description for the three accepted shapes; `date_from` (YYYY-MM-DD) is REQUIRED on each.",
          items: addressStop,
        },
        dest_addresses: {
          type: "array",
          description:
            "Delivery stop(s) — same item shape as from_addresses; `date_from` REQUIRED.",
          items: addressStop,
        },
        shipper_id: {
          type: "integer",
          optional: true,
          description:
            "Shipper id from galaxy_list_shippers() when booking for a specific shipper",
        },
        shipper_internal_ref: { type: "string", optional: true },
        other_reference: { type: "string", optional: true },
        accounting_entity_id: { type: "integer", optional: true },
        comment: { type: "string", optional: true, excludeFromHash: true },
        internal_ref: { type: "string", optional: true },
        carrier_ids: {
          type: "array",
          optional: true,
          items: { type: "integer" },
          description: "Other carriers to copy on the quote (RFQ)",
        },
        pre_awarded: {
          type: "boolean",
          optional: true,
          description: "Mark as pre-awarded (skip the RFQ round)",
        },
        total_weight: { type: "number", optional: true },
        total_volume: { type: "number", optional: true },
        total_linear_meters: { type: "number", optional: true },
        measurement_system: {
          type: "enum",
          values: ["metric", "imperial"],
          optional: true,
        },
        contents: {
          type: "array",
          optional: true,
          items: cargoLine,
          description:
            "Cargo lines. Each item requires `type_id` (from list_content_types()) and `quantity`. See item description for optional fields and the unknown-fields warning.",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_create_carrier_shipment_request_draft",
      kind: "write",
      summary: "Create a draft carrier-side shipment request",
      endpoint: {
        method: "POST",
        path: "/galaxy/carrier/shipment-requests/draft",
      },
      request: "sanitiseCreateShipmentRequest",
      params: {
        name: { type: "string" },
        shipment_mode_id: { type: "integer", optional: true },
        reply_before: {
          type: "string",
          optional: true,
          description:
            "Format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'.",
        },
        shipper_id: { type: "integer", optional: true },
        from_addresses: {
          type: "array",
          optional: true,
          items: addressStop,
          description:
            "Same item shape as galaxy_create_carrier_shipment_request. On drafts, `date_from` is OPTIONAL.",
        },
        dest_addresses: {
          type: "array",
          optional: true,
          items: addressStop,
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        internal_ref: { type: "string", optional: true },
        other_reference: { type: "string", optional: true },
        total_weight: { type: "number", optional: true },
        total_volume: { type: "number", optional: true },
        contents: {
          type: "array",
          optional: true,
          items: cargoLine,
          description:
            "Cargo lines (same item shape as galaxy_create_carrier_shipment_request).",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_upload_shipment_request_attachment",
      kind: "write",
      summary:
        "Upload one or several files onto a carrier-side shipment request",
      endpoint: {
        method: "POST",
        path: "/galaxy/shipment-requests/{id}/upload",
      },
      params: {
        id: { type: "integer", in: "path" },
        attachments: {
          type: "array",
          excludeFromHash: true,
          description:
            "Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`. Same documentType enum as the shipper version.",
          items: { type: "object", fields: {} },
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_send_shipment_request_message",
      kind: "write",
      summary:
        "Post a message in the booking chat of a carrier-side shipment request",
      endpoint: {
        method: "POST",
        path: "/galaxy/shipment-requests/{id}/message",
      },
      params: {
        id: { type: "integer", in: "path" },
        message: {
          type: "string",
          excludeFromHash: true,
          description: "Plain-text message body",
        },
        sender_name: { type: "string", optional: true },
        sender_email: { type: "email", optional: true },
      },
      returns: { ref: "WriteResult" },
    },

    // ─── Galaxy quote handling (carrier's RFQ response) ────────────
    //
    // No read action for price lines: `list_quote_requests` already ships
    // them inline as `price_details`. The two that used to live here
    // addressed /galaxy/carrier/shipment-requests/{id}/prices[/{priceId}]
    // — the sub-resource is not a GET at all, and the list variant answers
    // 404 for both the quote-request id and the shipment-request id.
    {
      name: "galaxy_cancel_quote_request",
      kind: "write",
      summary: "Cancel a quote request the carrier received",
      endpoint: {
        method: "PUT",
        path: "/galaxy/carrier/quote-requests/{id}/cancel",
      },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "WriteResult" },
    },

    // ─── Galaxy shipments (carrier execution) — read ───────────────
    {
      name: "galaxy_list_shipments",
      kind: "read",
      summary:
        "List shipments from the carrier's perspective — main tracking hub, ALWAYS date-filtered",
      // `/galaxy-data/shipments`, not `/galaxy/carrier/shipments` (a POST
      // that CREATES a shipment; the GET this used to declare 404'd).
      // This is also the read that spans a carrier GROUP: `list_shipments`
      // returns only the shipments of the account the token was issued on,
      // while this one covers every account the token reaches (measured:
      // 12 carrier accounts in one page).
      endpoint: { method: "GET", path: "/galaxy-data/shipments" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
        created_date_from: {
          type: "datetime",
          optional: true,
          description:
            "YYYY-MM-DD. PASS IT ON EVERY CALL: unlike list_shipments, this endpoint returns OLDEST-first, so an unfiltered call answers with the oldest shipments on the account — years old — and never reaches current ones.",
        },
        created_date_to: { type: "datetime", optional: true },
        departure_date_min: { type: "datetime", optional: true },
        departure_date_max: { type: "datetime", optional: true },
        arrival_date_min: { type: "datetime", optional: true },
        arrival_date_max: { type: "datetime", optional: true },
      },
      returns: { list: "Shipment" },
      response: "shipmentList",
    },
    {
      name: "galaxy_get_shipment",
      kind: "read",
      summary: "Fetch one carrier-side shipment by id",
      endpoint: { method: "GET", path: "/galaxy/shipments/{id}" },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "Shipment" },
      response: "shipment",
    },
    {
      name: "galaxy_list_tracking_points",
      kind: "read",
      summary:
        "List the tracking points (stops / events) of a carrier-side shipment",
      endpoint: {
        method: "GET",
        path: "/galaxy/shipments/{id}/tracking-points",
      },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "TrackingPoint" },
    },
    {
      name: "galaxy_list_shipment_attachments",
      kind: "read",
      summary: "List attachments on a carrier-side shipment",
      endpoint: {
        method: "GET",
        path: "/galaxy/carrier/shipments/{id}/attachments",
      },
      params: { id: { type: "integer", in: "path" } },
      returns: { list: "Attachment" },
    },

    // ─── Galaxy shipments — write ──────────────────────────────────
    {
      name: "galaxy_confirm_shipment_pickup",
      kind: "write",
      summary:
        "Confirm pickup of a carrier-side shipment (creates the actual pickup point)",
      endpoint: {
        method: "PUT",
        path: "/galaxy/shipments/{id}/pickup/confirm",
      },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", description: "Pickup date — YYYY-MM-DD" },
        time: {
          type: "string",
          optional: true,
          description: "Pickup time — HH:mm",
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        incident: {
          type: "string",
          optional: true,
          description:
            "Incident label (e.g. 'Customs clearance', 'Strike', 'Truck incident'). Omit when pickup is on time.",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_confirm_shipment_delivery",
      kind: "write",
      summary: "Confirm delivery of a carrier-side shipment",
      endpoint: {
        method: "PUT",
        path: "/galaxy/shipments/{id}/delivery/confirm",
      },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", description: "Delivery date — YYYY-MM-DD" },
        time: { type: "string", optional: true },
        comment: { type: "string", optional: true, excludeFromHash: true },
        incident: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_replan_shipment_pickup",
      kind: "write",
      summary: "Replan pickup of a carrier-side shipment",
      endpoint: { method: "PUT", path: "/galaxy/shipments/{id}/pickup/replan" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true, description: "YYYY-MM-DD" },
        time: { type: "string", optional: true, description: "HH:mm" },
        comment: { type: "string", optional: true, excludeFromHash: true },
        reason: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_replan_shipment_delivery",
      kind: "write",
      summary: "Replan delivery of a carrier-side shipment",
      endpoint: {
        method: "PUT",
        path: "/galaxy/shipments/{id}/delivery/replan",
      },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true },
        time: { type: "string", optional: true },
        comment: { type: "string", optional: true, excludeFromHash: true },
        reason: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_confirm_shipment",
      kind: "write",
      summary:
        "Confirm the whole shipment (distinct from per-leg pickup / delivery)",
      endpoint: { method: "PUT", path: "/galaxy/shipments/{id}/confirm" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true, description: "YYYY-MM-DD" },
        time: { type: "string", optional: true, description: "HH:mm (UTC)" },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_cancel_shipment",
      kind: "write",
      summary: "Cancel a carrier-side shipment",
      endpoint: { method: "PUT", path: "/galaxy/shipments/{id}/cancel" },
      params: {
        id: { type: "integer", in: "path" },
        comment: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_upload_shipment_attachment",
      kind: "write",
      summary: "Upload one or several files onto a carrier-side shipment",
      endpoint: { method: "POST", path: "/galaxy/shipments/{id}/upload" },
      params: {
        id: { type: "integer", in: "path" },
        attachments: {
          type: "array",
          excludeFromHash: true,
          description:
            "Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`",
          items: { type: "object", fields: {} },
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_send_shipment_message",
      kind: "write",
      summary: "Post a message in the tracking chat of a carrier-side shipment",
      endpoint: { method: "POST", path: "/galaxy/shipments/{id}/message" },
      params: {
        id: { type: "integer", in: "path" },
        message: {
          type: "string",
          excludeFromHash: true,
          description: "Plain-text message body",
        },
        sender_name: { type: "string", optional: true },
        sender_email: { type: "email", optional: true },
      },
      returns: { ref: "WriteResult" },
    },

    // ─── Galaxy tracking-point granular ops ────────────────────────
    {
      name: "galaxy_confirm_tracking_point",
      kind: "write",
      summary:
        "Confirm a single tracking point (transit stop, customs, …) of a carrier-side shipment",
      endpoint: { method: "PUT", path: "/galaxy/tracking-points/{id}/confirm" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true, description: "YYYY-MM-DD" },
        time: { type: "string", optional: true, description: "HH:mm" },
        comment: { type: "string", optional: true, excludeFromHash: true },
        incident: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_replan_tracking_point",
      kind: "write",
      summary: "Replan a single tracking point of a carrier-side shipment",
      endpoint: { method: "PUT", path: "/galaxy/tracking-points/{id}/replan" },
      params: {
        id: { type: "integer", in: "path" },
        date: { type: "string", optional: true, description: "YYYY-MM-DD" },
        time: { type: "string", optional: true, description: "HH:mm" },
        comment: { type: "string", optional: true, excludeFromHash: true },
        reason: { type: "string", optional: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_cancel_tracking_point",
      kind: "write",
      summary: "Cancel a single tracking point of a carrier-side shipment",
      endpoint: { method: "PUT", path: "/galaxy/tracking-points/{id}/cancel" },
      params: {
        id: { type: "integer", in: "path" },
        comment: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "galaxy_update_tracking_point_location",
      kind: "write",
      summary:
        "Move a tracking point of a carrier-side shipment to a different address",
      // PATCH, not PUT — the PUT spelling this used to declare is not a
      // route and answered 404.
      endpoint: {
        method: "PATCH",
        path: "/galaxy/shipments/{id}/tracking-points/location",
      },
      params: {
        id: { type: "integer", in: "path" },
        address_id: {
          type: "integer",
          description: "Target address id from list_locations()",
        },
        tracking_point_id: {
          type: "integer",
          optional: true,
          description:
            "Specific tracking point to move — omit to move the default one",
        },
      },
      returns: { ref: "WriteResult" },
    },

    // ─── Galaxy reference data ─────────────────────────────────────
    {
      name: "galaxy_list_shippers",
      kind: "read",
      summary:
        "List active shippers a carrier works with — carrier counterpart of list_carriers",
      endpoint: { method: "GET", path: "/galaxy/carrier/shippers/active" },
      params: {},
      returns: { list: "GalaxyShipper" },
    },
    {
      name: "galaxy_get_attachment_download_url",
      kind: "read",
      summary:
        "Get a signed URL to download one attachment on a carrier-side shipment",
      endpoint: { method: "GET", path: "/galaxy/attachments/{id}/download" },
      params: { id: { type: "integer", in: "path" } },
      returns: { ref: "AttachmentDownload" },
      response: "attachmentDownload",
    },
  ],
};
