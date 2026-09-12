# Payload shapes

What Pbyp accepts, per object. The typed actions build these for you; this file is what you need when you fall back to `create_items` / `update_items`.

## The three shapes of a relation

`describe_collection()` names each link's kind; `create_items` refuses the wrong shape before it leaves.

| Kind         | Write it as                                  | Example                                                                      |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| many-to-one  | the id, or a nested object to create the row | `"shipper": 412` · `"shipper": {"name": "…", "code": "…", "country_id": 75}` |
| one-to-many  | an array of child rows                       | `"flights": [{"pol": 3, "pod": 9, "etd": "…", "eta": "…"}]`                  |
| many-to-many | an array of **junction** rows                | `"parcels": [{"parcels_id": 41}]`                                            |

A many-to-many junction row may itself carry a nested create: `{"parcels_id": {"type": "Carton", "quantity": 6}}` makes the parcel and the link in one write. That is how `create_order` submits cargo.

`[41, 42]` on a many-to-many is accepted by Directus and read as **junction row ids**, so it links unrelated rows and reports success. Never write it.

Which columns you may not send at all is a property of the column, not a list to memorise: `describe_collection()` flags them `computed`. They are stripped and echoed back in `stripped`. `entity_id` is stripped on **update** only — an object never changes owner (see `access-and-scope.md`).

## Orders

```json
{
  "number": "3O2026090007",
  "transport_type": "sea",
  "date": "2026-09-08",
  "incoterm": "FOB",
  "entity_id": 3,
  "shipper": 412,
  "consignee": {
    "name": "Macy's",
    "code": "MACYS",
    "city": "New York",
    "code_country": "US"
  },
  "client_reference": "PO-4471",
  "pickup_date": "2026-09-10T08:00:00Z",
  "delivery_date": "2026-09-30",
  "parcels": [
    {
      "parcels_id": {
        "type": "Carton",
        "quantity": 6,
        "weight": 37,
        "volume": 0.4,
        "taxable_weight": 400
      }
    }
  ],
  "associated_entities": [{ "entities_id": 39, "can_edit": false }],
  "sea_folders": [{ "sea_folders_id": 88 }]
}
```

`number` is required and not generated — build it from `next_order_number()`.

## Folders

Same party and date shape. Additional rules:

- `folder_type: "house"` → `master_id` is required.
- `folder_type` other than `"master"` → `payer_id` is required.
- `folder_number` is assigned by Pbyp. Its generator uses a **0-indexed month** (`<entity><S|A><YYYY><MM 0-indexed><NNNN>`), unlike the order and quotation numbers, which are 1-indexed. Never build one.
- Orders attach as `"orders": [{"orders_id": 51}]`; the sharing list is `folders_entities`, not `associated_entities`.
- `voyage_id` points at the booking. Setting it is what makes the folder inherit the voyage's status.

## Bookings

Sea:

```json
{
  "booking_number": "BK-2026-118",
  "entity_id": 3,
  "ship_name": "CMA CGM BALI",
  "voyage_number": "0FA9WS1MA",
  "companies": [{ "oversea_companies_id": 12 }],
  "departure_terminal": 3,
  "arrival_terminal": 9,
  "ETD": "2026-09-20T00:00:00Z",
  "ETA": "2026-10-18T00:00:00Z",
  "containers": [
    { "number": "CMAU0945402", "type": "40HC", "shipping_method": "FCL/FCL" }
  ]
}
```

`booking_type` is `import` \| `export` — the direction for the agency, not a master/house distinction. `booking_type`, both terminals and both dates are NOT NULL on a sea booking: there is no way to create one with an open route.

`companies` **or** `custom_company`, never both. Container numbers are ISO 6346 and the check digit is verified before the call; `TMPU0000003` is Pbyp's placeholder for cargo not yet in a known box.

Air: no `containers` and no route of its own — `flights` carries it, and a create filter copies the first leg's `pol`/`etd` and the last leg's `pod`/`eta` onto the booking before the insert. `LTA` is required.

```json
{
  "booking_number": "AB-2026-31",
  "entity_id": 3,
  "LTA": "057-12345675",
  "flights": [
    {
      "number": "AF6748",
      "pol": 14,
      "pod": 22,
      "etd": "2026-09-21T21:40:00Z",
      "eta": "2026-09-22T06:10:00Z"
    }
  ]
}
```

The LTA is 3 airline digits + 8, the last a modulo-7 check of the preceding seven.

## Events

Use `add_event()`. Written by hand, the shape is:

```json
{
  "type": 1,
  "date": "2026-09-07T08:00:00Z",
  "actual": true,
  "source": "user",
  "sea_folders": [{ "sea_folders_id": 88 }]
}
```

**Exactly one** of `orders`, `sea_folders`, `air_folders`, `sea_bookings`, `air_bookings`, `containers`. Zero or two is a bare `INVALID_PAYLOAD_ERROR`. `code` is composed by the hook.

## Cargo lines

A parcel line is `{type, quantity, weight, volume, meterage, taxable_weight, description}`, plus `is_adr` with `adr: [{"adr_id": 3}]` for dangerous goods, and `is_controlled_temperature` with `minimal_temperature` / `maximal_temperature` for reefer cargo.

`taxable_weight` is the billed weight: `max(weight, volume × 1000)` at sea, `max(weight, volume × 167)` in the air. `set_parcels()` and the typed creates compute it when you omit it.

**A parcel list REPLACES.** `update_items("orders", …, {"parcels": [...]})` drops every line not in the new list. To add one, read the current list first — or use `assign_containers`, which splits lines rather than replacing them.

## Stuffing containers

`assign_containers()` is an endpoint, not a write on `/items`, because it rebalances the cargo lines:

- `container_link_type: "full"` — the whole order or folder goes into one `container_id`; every parcel line is moved there.
- `container_link_type: "dispatched"` — each line names its own container. Pbyp splits a line whose quantity is partially assigned and keeps the remainder as an unassigned line, so quantities stay conserved.

`unassign_parcel_container()` reverses one line, merging it back into the unassigned line of the same type.

## Address vs address book

`address` rows are **copies on a shipment**. `address_book` is the entity's directory. Creating an order with a nested `shipper` object creates an `address`, not a directory entry; to add to the directory, write `address_book` explicitly (it needs `entity_id`).

Both need `name`, `code` and a country (`country_id`, or `code_country` on the typed actions, which resolve it). `code` defaults to the name when omitted on the typed actions; on a raw `create_items` it is required.

## Numbering

| Object    | Pattern                                       | Source                    |
| --------- | --------------------------------------------- | ------------------------- |
| order     | `<entity_id>O<YYYYMM><NNNN>`                  | `next_order_number()`     |
| quotation | `Q<entity_id><YYYYMM><NNNN>`                  | `next_quotation_number()` |
| folder    | `<entity_id><S\|A><YYYY><MM 0-indexed><NNNN>` | Pbyp, on create           |

Both counters are per entity and per calendar month, and count `date_created`. They return the next value, not a reservation — two calls in the same minute return the same counter, so create the object before asking again.
