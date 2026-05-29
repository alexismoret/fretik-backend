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
