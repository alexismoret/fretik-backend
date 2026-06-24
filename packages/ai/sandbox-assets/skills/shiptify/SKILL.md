---
name: shiptify
description: Shiptify — manage shipment requests and shipments: book, track, confirm pickup/delivery, exchange documents
version: 30b033bce920
---

# Shiptify — 54 actions

You can interact with the user's Shiptify account via the `fretik_apps.shiptify` Python module.

## Read actions (auto-approved, eager)

- `shiptify.list_shipment_requests(limit=25, offset=0)` — List shipment requests on the account
- `shiptify.get_shipment_request(id)` — Fetch one shipment request by id
- `shiptify.list_shipment_request_attachments(id)` — List attachments on a shipment request
- `shiptify.list_shipment_request_shipments(id)` — List the shipments produced by a shipment request
- `shiptify.list_shipments(limit=25, offset=0, created_date_from=None, created_date_to=None, departure_date_min=None, departure_date_max=None, arrival_date_min=None, arrival_date_max=None, sh_request_id=None, sr_internal_ref=None, from_address_id=None, dest_address_id=None, from_address_internal_ref=None, dest_address_internal_ref=None, shipper_id=None)` — List shipments — the main tracking hub
- `shiptify.get_shipment(id)` — Fetch one shipment by id
- `shiptify.list_tracking_points(id)` — List the tracking points (stops / events) of a shipment
- `shiptify.list_shipment_attachments(id)` — List attachments on a shipment
- `shiptify.get_attachment_download_url(id)` — Get a signed URL to download one attachment
- `shiptify.list_locations(limit=25, offset=0, q=None, internal_ref=None)` — List address-book locations — call before creating a SR to pick from/dest address ids
- `shiptify.list_carriers(internal_ref=None)` — List active carriers on the account
- `shiptify.list_shipment_modes()` — List shipment modes (road / sea / air / …) — call before create_shipment_request
- `shiptify.list_content_types()` — List active cargo content types — call before any create_shipment_request\* to resolve `type_id` on each cargo line
- `shiptify.galaxy_list_carrier_shipment_requests(limit=25, offset=0)` — List shipment requests received as a carrier (the quote inbox)
- `shiptify.galaxy_list_ready_to_book(limit=25, offset=0)` — List awarded shipment requests waiting for the carrier to book them
- `shiptify.galaxy_list_shipment_request_attachments(id)` — List attachments on a carrier-side shipment request
- `shiptify.galaxy_list_quote_prices(id)` — List the price lines proposed on a carrier-side quote
- `shiptify.galaxy_get_quote_price(id, priceId)` — Fetch one price line on a carrier-side quote
- `shiptify.galaxy_list_shipments(limit=25, offset=0)` — List shipments from the carrier's perspective — main tracking hub
- `shiptify.galaxy_get_shipment(id)` — Fetch one carrier-side shipment by id
- `shiptify.galaxy_list_tracking_points(id)` — List the tracking points (stops / events) of a carrier-side shipment
- `shiptify.galaxy_list_shipment_attachments(id)` — List attachments on a carrier-side shipment
- `shiptify.galaxy_list_shippers()` — List active shippers a carrier works with — carrier counterpart of list_carriers
- `shiptify.galaxy_get_attachment_download_url(id)` — Get a signed URL to download one attachment on a carrier-side shipment

## Write actions (require user approval — build with `.op()`)

- `shiptify.create_shipment_request(name, shipment_mode_id, reply_before, from_addresses, dest_addresses, accounting_entity_id=None, carrier_id=None, carrier_ids=None, comment=None, internal_note=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, total_linear_meters=None, measurement_system=None, contents=None)` — Create a new shipment request (booking)
- `shiptify.create_shipment_request_draft(name, shipment_mode_id=None, reply_before=None, from_addresses=None, dest_addresses=None, comment=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, contents=None)` — Create a draft shipment request (status: draft)
- `shiptify.update_shipment_request(id, name=None, accounting_entity_id=None, comment=None, internal_note=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, total_linear_meters=None, measurement_system=None)` — Update fields of a shipment request
- `shiptify.cancel_shipment_request(id)` — Cancel a shipment request
- `shiptify.upload_shipment_request_attachment(id, attachments, carrier_id=None)` — Upload one or several files onto a shipment request
- `shiptify.send_shipment_request_message(id, message, carrier_id=None, sender_name=None, sender_email=None)` — Post a message in the booking chat of a shipment request
- `shiptify.confirm_shipment_pickup(id, date, time=None, comment=None, incident=None, cause_id=None)` — Confirm pickup of a shipment (creates the actual pickup point)
- `shiptify.confirm_shipment_delivery(id, date, time=None, comment=None, incident=None, cause_id=None)` — Confirm delivery of a shipment
- `shiptify.replan_shipment_pickup(id, date=None, time=None, comment=None, reason=None)` — Replan pickup of a shipment (new date / time)
- `shiptify.replan_shipment_delivery(id, date=None, time=None, comment=None, reason=None)` — Replan delivery of a shipment
- `shiptify.upload_shipment_attachment(id, attachments)` — Upload one or several files onto a shipment
- `shiptify.send_shipment_message(id, message, sender_name=None, sender_email=None)` — Post a message in the tracking chat of a shipment
- `shiptify.create_location(name, address_1, city, zipcode, country, type=None, address_2=None, state=None, recipient_name=None, company_name=None, email=None, phone_number=None, instructions=None, internal_ref=None, locode=None, contact=None)` — Create a new address-book location — use ONLY when list_locations returned no match
- `shiptify.galaxy_create_carrier_shipment_request(name, shipment_mode_id, reply_before, from_addresses, dest_addresses, shipper_id=None, shipper_internal_ref=None, other_reference=None, accounting_entity_id=None, comment=None, internal_ref=None, carrier_ids=None, pre_awarded=None, total_weight=None, total_volume=None, total_linear_meters=None, measurement_system=None, contents=None)` — Create a carrier-initiated shipment request (spot booking)
- `shiptify.galaxy_create_carrier_shipment_request_draft(name, shipment_mode_id=None, reply_before=None, shipper_id=None, from_addresses=None, dest_addresses=None, comment=None, internal_ref=None, other_reference=None, total_weight=None, total_volume=None, contents=None)` — Create a draft carrier-side shipment request
- `shiptify.galaxy_upload_shipment_request_attachment(id, attachments)` — Upload one or several files onto a carrier-side shipment request
- `shiptify.galaxy_send_shipment_request_message(id, message, sender_name=None, sender_email=None)` — Post a message in the booking chat of a carrier-side shipment request
- `shiptify.galaxy_cancel_quote_request(id)` — Cancel a quote request the carrier received
- `shiptify.galaxy_confirm_shipment_pickup(id, date, time=None, comment=None, incident=None)` — Confirm pickup of a carrier-side shipment (creates the actual pickup point)
- `shiptify.galaxy_confirm_shipment_delivery(id, date, time=None, comment=None, incident=None)` — Confirm delivery of a carrier-side shipment
- `shiptify.galaxy_replan_shipment_pickup(id, date=None, time=None, comment=None, reason=None)` — Replan pickup of a carrier-side shipment
- `shiptify.galaxy_replan_shipment_delivery(id, date=None, time=None, comment=None, reason=None)` — Replan delivery of a carrier-side shipment
- `shiptify.galaxy_confirm_shipment(id, date=None, time=None)` — Confirm the whole shipment (distinct from per-leg pickup / delivery)
- `shiptify.galaxy_cancel_shipment(id, comment=None)` — Cancel a carrier-side shipment
- `shiptify.galaxy_upload_shipment_attachment(id, attachments)` — Upload one or several files onto a carrier-side shipment
- `shiptify.galaxy_send_shipment_message(id, message, sender_name=None, sender_email=None)` — Post a message in the tracking chat of a carrier-side shipment
- `shiptify.galaxy_confirm_tracking_point(id, date=None, time=None, comment=None, incident=None)` — Confirm a single tracking point (transit stop, customs, …) of a carrier-side shipment
- `shiptify.galaxy_replan_tracking_point(id, date=None, time=None, comment=None, reason=None)` — Replan a single tracking point of a carrier-side shipment
- `shiptify.galaxy_cancel_tracking_point(id, comment=None)` — Cancel a single tracking point of a carrier-side shipment
- `shiptify.galaxy_update_tracking_point_location(id, address_id, tracking_point_id=None)` — Move a tracking point of a carrier-side shipment to a different address

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `ShipmentRequest` — `id: int`, `internal_ref?: str`, `name: str`, `status: str`, `shipment_mode_id?: int`, `reply_before?: str`, `total_weight?: float`, `total_volume?: float`, `total_linear_meters?: float`, `comment?: str`, `created_at?: str`
- `Shipment` — `id: int`, `code?: str`, `status: str`, `tracking_code?: str`, `name?: str`, `internal_ref?: str`, `shipper_id?: int`, `carrier_id?: int`, `sh_request_id?: int`, `total_weight?: float`, `total_volume?: float`, `total_linear_meters?: float`, `estimated_departure_time?: str`, `real_departure_time?: str`, `estimated_arrival_time?: str`, `real_arrival_time?: str`, `shipment_mode?: str`, `shiptify_private_link?: str`, `shiptify_public_link?: str`
- `TrackingPoint` — `id: int`, `shipment_id?: int`, `type?: str`, `position?: int`, `address_id?: int`, `planned_date?: str`, `planned_time?: str`, `real_date?: str`, `real_time?: str`, `incident?: str`, `comment?: str`
- `Attachment` — `id: int`, `name: str`, `type?: str`, `status?: str`
- `Location` — `id: int`, `name: str`, `internal_ref?: str`, `recipient_name?: str`, `address_1?: str`, `address_2?: str`, `city?: str`, `state?: str`, `zipcode?: str`, `country?: str`, `type?: str`
- `Carrier` — `id: int`, `name: str`, `code?: str`, `scac?: str`, `internal_ref?: str`
- `ShipmentMode` — `id: int`, `name: str`
- `ContentType` — `id: int`, `name: str`, `length?: float`, `width?: float`, `height?: float`, `weight?: float`, `dimension_unit?: str`, `weight_unit?: str`, `is_container?: bool`, `iso_container_type?: str`, `for_road?: bool`, `for_sea?: bool`, `for_air?: bool`, `for_rail?: bool`
- `WriteResult` — `id?: int`, `internal_ref?: str`, `successful?: bool`
- `AttachmentDownload` — `url: str`
- `GalaxyShipment` — `id: int`, `code?: str`, `status?: str`, `tracking_code?: str`, `name?: str`, `internal_ref?: str`, `other_reference?: str`, `shipper_id?: int`, `carrier_id?: int`, `sh_request_id?: int`, `quote_request_id?: int`, `weight?: str`, `cost?: str`, `goods_value?: str`, `date?: str`, `in_out?: str`, `co2_amount?: float`, `archived_carrier?: bool`, `shipment_mode?: str`
- `GalaxyShipmentRequest` — `id: int`, `name?: str`, `status?: str`, `internal_ref?: str`, `other_reference?: str`, `shipper_id?: int`, `shipper_internal_ref?: str`, `shipment_mode?: str`, `shipment_mode_id?: int`, `reply_before?: str`, `total_weight?: float`, `total_volume?: float`, `total_linear_meters?: float`, `pre_awarded?: bool`, `comment?: str`, `created_at?: str`
- `GalaxyPriceQuote` — `id: int`, `price_detail_id?: int`, `price?: float`
- `GalaxyShipper` — `id: int`, `name: str`, `account_id?: int`

## Pick the right action set for your account role

Every Shiptify connection has an `account_type` (`shipper` or `carrier`) surfaced in the `<external_apps>` block. The agent MUST read it before picking an action:

- **`shipper`** accounts call the unprefixed actions: `create_shipment_request`, `list_shipments`, `confirm_shipment_pickup`, `upload_shipment_attachment`, `send_shipment_message`, …
- **`carrier`** accounts call the `galaxy_*` actions: `galaxy_create_carrier_shipment_request`, `galaxy_list_shipments`, `galaxy_confirm_shipment_pickup`, `galaxy_upload_shipment_attachment`, `galaxy_send_shipment_message`, …
- **Lookups are shared** for both roles: `list_locations`, `create_location`, `list_shipment_modes`, `list_carriers` (shipper view) / `galaxy_list_shippers` (carrier view).

Calling a shipper action on a carrier connection (or vice-versa) returns `403 "User is not <role>"`. Never silently retry; switch to the `galaxy_*` (or unprefixed) counterpart.

## Patterns

### Create a shipment request from scratch (shipper)

Building a valid `create_shipment_request` requires resolving four lookups first:

1. `list_shipment_modes()` → pick the matching `shipment_mode_id` (road / sea / air / rail / …).
2. `list_content_types()` → pick the `type_id` for each cargo line (filter by `for_road` / `for_sea` / … to match the mode).
3. `list_locations(q="<origin city or supplier name>")` → get the `id` to use as `address_id` inside `from_addresses`. Repeat for the destination.
4. `list_carriers()` if the user wants to lock the booking to a specific carrier — otherwise omit, the platform will RFQ.

```python
modes = shiptify.list_shipment_modes()
road = next(m for m in modes if m.name.lower() == "road")
ctypes = shiptify.list_content_types()
pallet = next(c for c in ctypes if c.for_road and "pallet" in c.name.lower())
origins = shiptify.list_locations(q="Marseille warehouse")
dests = shiptify.list_locations(q="Lyon DC")

run_plan([
    shiptify.create_shipment_request.op(
        name="MAR-LYO 2026-06-12",
        shipment_mode_id=road.id,
        reply_before="2026-06-10T18:00:00",  # no timezone suffix
        from_addresses=[{"address_id": origins[0].id, "date_from": "2026-06-12"}],
        dest_addresses=[{"address_id": dests[0].id, "date_from": "2026-06-13"}],
        total_weight=820.0,
        comment="2 pallets, fragile.",
        contents=[{"type_id": pallet.id, "quantity": 2, "weight": 410}],
    ),
])
```

### Pitfalls when creating a shipment request (shipper AND carrier)

Three things the Shiptify API will reject across BOTH `create_shipment_request` and `galaxy_create_carrier_shipment_request`:

- **Addresses without `date_from`**: every stop (pickup and delivery) MUST carry `date_from: "YYYY-MM-DD"`. Without it, the whole `oneOf` validation fails server-side → `"from_addresses[0] does not match any of the allowed types"`. Pick a reasonable date and surface it to the user during approval review if unsure.
- **`reply_before` with a timezone**: Shiptify rejects `2026-06-10T18:00:00+02:00`. Send `2026-06-10T18:00:00` (no `Z`, no `+HH:MM`). A request mapper strips the suffix defensively, but emitting the right form keeps the approval card readable.
- **`contents[i]` without a valid `type_id`**: call `list_content_types()` first to resolve the id (filter by mode flag `for_road`/`for_sea`/`for_air`/`for_rail`). `quantity` is also required. Do NOT pass `m3` / `volume_m3` per line — those fields do not exist; aggregate to top-level `total_volume` (cubic metres) instead. Unknown fields are silently dropped.

Free-text address objects WITHOUT an `address_id` ARE supported (inline branch: `address_1, city, country, zipcode, date_from` + optional fields), but validation is strict — prefer `create_location` + `address_id` whenever possible.

### Create a new location (only when it does not exist yet)

If `list_locations(q=...)` returns no match for an address the user wants to use, fall back to `create_location` — then thread the new location's `id` into the `from_addresses` / `dest_addresses` of the next plan. **Do this in two turns**, not one: the new id is the output of a read+write step, so the address-id literals you put in `create_shipment_request.op(...)` must come from the previous turn's confirmed creation.

```python
# Turn 1 — make sure the location exists.
matches = shiptify.list_locations(q="ACME Bordeaux DC")
if not matches:
    run_plan([
        shiptify.create_location.op(
            name="ACME Bordeaux DC",
            address_1="12 rue de la Logistique",
            zipcode="33000",
            city="Bordeaux",
            country="FR",
            type="warehouse",
            internal_ref="ACME-BX-01",
        ),
    ])
# (user approves; next turn the new location is committed)

# Turn 2 — re-fetch and book against it.
matches = shiptify.list_locations(q="ACME Bordeaux DC")
dests = shiptify.list_locations(q="Lyon DC")
modes = shiptify.list_shipment_modes()
road = next(m for m in modes if m.name.lower() == "road")
run_plan([
    shiptify.create_shipment_request.op(
        name="BDX-LYO 2026-06-15",
        shipment_mode_id=road.id,
        reply_before="2026-06-13T18:00:00",
        from_addresses=[{"address_id": matches[0].id}],
        dest_addresses=[{"address_id": dests[0].id}],
    ),
])
```

Only create a location when no existing entry fits — otherwise the address book grows duplicates the user has to clean up later. When in doubt about a near-match, ask the user to confirm.

### Track a shipment end-to-end

The hub is `list_shipments` — it accepts strong filters (`sh_request_id`, `sr_internal_ref`, `created_date_from/to`, `departure_date_min/max`, `from_address_id`, `dest_address_id`). Drill down into one shipment with `get_shipment` + `list_tracking_points`.

```python
shipments = shiptify.list_shipments(sr_internal_ref="PO-4421", limit=10)
for s in shipments:
    points = shiptify.list_tracking_points(id=s.id)
    print(s.code, s.status, [(p.type, p.real_date or p.planned_date) for p in points])
```

### Confirm pickup / delivery, or replan

`confirm_*` and `replan_*` are separate actions because they have different shapes — confirm records the actual date; replan moves the planned date. Both are write actions and go through `run_plan` for user approval.

```python
run_plan([
    shiptify.confirm_shipment_pickup.op(
        id=812345,
        date="2026-06-12",
        time="08:30",
        comment="Driver arrived 30 min early.",
    ),
])
```

Use `incident` only when something went wrong — common labels: `Customs clearance`, `Strike`, `Truck incident`, `Waiting at pick up place`, `Delivery truck failure`. Omit it when the pickup is on time.

### Attach a document (BL, CMR, invoice, POD …)

`documentType` is a strict enum — pick the matching slug from the list in the action description. Encode the file as base64 OR pass a `url` Shiptify can fetch.

```python
run_plan([
    shiptify.upload_shipment_attachment.op(
        id=812345,
        attachments=[{
            "fileName": "POD_812345.pdf",
            "documentType": "proof_of_delivery",
            "base64Data": pdf_b64,
            "accessType": "limited",
            "save": True,
        }],
    ),
])
```

To later read an attachment, call `get_attachment_download_url(id=...)` — it returns a short-lived signed URL the user can open. On a carrier connection, use `galaxy_get_attachment_download_url(id=...)` instead.

### Carrier — handle a quote and confirm pickup

```python
# 1) Read the carrier inbox — quote requests awaiting your price.
reqs = shiptify.galaxy_list_carrier_shipment_requests(limit=10)
ready = shiptify.galaxy_list_ready_to_book(limit=10)

# 2) Inspect one quote and any existing price lines.
req = ready[0]
prices = shiptify.galaxy_list_quote_prices(id=req.id)

# 3) Track shipments and confirm pickup once a truck has arrived.
shipments = shiptify.galaxy_list_shipments(limit=10)
points = shiptify.galaxy_list_tracking_points(id=shipments[0].id)

run_plan([
    shiptify.galaxy_confirm_shipment_pickup.op(
        id=shipments[0].id,
        date="2026-06-12",
        time="08:30",
        comment="Driver on site, loading complete.",
    ),
])
```

For an attached document on a carrier shipment, the upload action is `galaxy_upload_shipment_attachment(id, attachments=[...])` — same `documentType` enum as the shipper version. Messages to the shipper go through `galaxy_send_shipment_message(id, message)`.

### Carrier — create a spot-booking shipment request

For a freight forwarder dispatching one of their own bookings, `galaxy_create_carrier_shipment_request` takes the same shape as the shipper-side `create_shipment_request` plus a `shipper_id` (resolved from `galaxy_list_shippers()`).

```python
modes = shiptify.list_shipment_modes()
sea = next(m for m in modes if m.name.lower() in ("sea", "ocean"))
ctypes = shiptify.list_content_types()
container_40hc = next(
    c for c in ctypes
    if c.for_sea and (c.iso_container_type or "").upper() == "40HC"
)
shippers = shiptify.galaxy_list_shippers()
shipper = next(s for s in shippers if "fibertex" in s.name.lower())

origins = shiptify.list_locations(q="Fibertex Nonwovens")
dests = shiptify.list_locations(q="Midwest Acoust-A-Fiber")
# If list_locations returns no match, create_location() first and re-fetch
# in the next turn — same two-turn pattern as the shipper section above.

run_plan([
    shiptify.galaxy_create_carrier_shipment_request.op(
        name="Fibertex — PO3144129 — Midwest Acoust-A-Fiber",
        shipment_mode_id=sea.id,
        shipper_id=shipper.id,
        reply_before="2026-06-10T18:00:00",  # no timezone
        from_addresses=[
            {"address_id": origins[0].id, "date_from": "2026-06-15"},
        ],
        dest_addresses=[
            {"address_id": dests[0].id, "date_from": "2026-07-05"},
        ],
        internal_ref="PO3144129",
        other_reference="SO3128381",
        total_weight=6078.0,
        total_volume=30.2,
        comment="40' HC container, DDP INCOTERMS 2020.",
        contents=[
            {"type_id": container_40hc.id, "quantity": 1, "comment": "40' HC container"},
        ],
    ),
])
```

When the cargo ships as one container, emit one `contents` line for the container itself — NOT one line per SKU. Per-SKU detail belongs in the booking `comment` or in a follow-up attachment; the API has no `m3` per line and unknown fields are silently dropped.

### Multiple connected Shiptify accounts

When the user has connected several Shiptify accounts (e.g. one carrier-side, one shipper-side), the system-prompt `<external_apps>` block lists them with their `account_label`, `connection_id`, AND `account_type`. The `account_type` is the deciding factor for which action prefix to use (`galaxy_*` for carrier, unprefixed for shipper) — do NOT guess from the display name. Every Shiptify action accepts an implicit `connection_id="<uuid>"` argument that picks the right one; never prompt the user when the block already disambiguates.

---

## Write actions & approval

Write actions NEVER execute on their own. Build them with `.op()` and
submit them together via `run_plan([...])` — the user approves the whole
plan ONCE.

- One write: `shiptify.create_shipment_request(name="…", shipment_mode_id=1, reply_before="…", …)`
- Many writes: `run_plan([ shiptify.<action>.op(...), ... ])`

When you call `run_plan` (or a direct write), it raises
`fretik_apps.ApprovalPending`. This is EXPECTED — not an error. STOP.
The user reviews the plan in the UI; you will be prompted to continue.
When prompted, RE-RUN THE EXACT SAME CODE — the approved plan then
executes; reads re-run harmlessly. If the user rejects, you receive
their feedback as a message — adapt and write new code.

### STRONG RULE — read→write flows

When a plan depends on data you just read, you MUST inline the read
results as EXPLICIT LITERALS in the `.op()` calls. Do NOT compute
`.op()` arguments from a read performed in the same script as
`run_plan`.

Correct: read in one turn, inspect the results, THEN in the next turn
write `run_plan([...])` with concrete IDs / addresses as literals.

Why: on re-run after approval, a volatile read (inbox changed) would
change the plan's lookupHash and force a needless re-approval.

### Plan rules

- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- For several writes, ALWAYS use a single `run_plan` — never chain
  bare writes.
- Partial failures come back per-op; re-submit a `run_plan` with only
  the failed ops.
