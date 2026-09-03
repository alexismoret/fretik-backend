---
name: shiptify
description: Shiptify — manage transport shipments, addresses, and related records on the connected Shiptify TMS account (shipper or carrier).
version: 3825c82153e1
---

# Shiptify — 50 actions

You can interact with the user's Shiptify account via the `fretik_apps.shiptify` Python module.

## Read actions (auto-approved, eager)

- `shiptify.list_shipment_requests(limit=25, offset=0)` — List shipment requests on the account
- `shiptify.get_shipment_request(id)` — Fetch one shipment request by id
- `shiptify.list_shipment_request_attachments(id)` — List attachments on a shipment request
- `shiptify.list_shipment_request_shipments(id)` — List the shipments produced by a shipment request
- `shiptify.list_shipments(limit=25, offset=0, created_date_from=None, created_date_to=None, departure_date_min=None, departure_date_max=None, arrival_date_min=None, arrival_date_max=None, sh_request_id=None, sr_internal_ref=None, from_address_id=None, dest_address_id=None, from_address_internal_ref=None, dest_address_internal_ref=None, shipper_id=None)` — List shipments — the shipper's main tracking hub, with strong filters
- `shiptify.get_shipment(id)` — Fetch one shipment by id
- `shiptify.list_tracking_points(id)` — List the tracking points (stops / events) of a shipment
- `shiptify.list_shipment_attachments(id)` — List attachments on a shipment
- `shiptify.get_attachment_download_url(id)` — Get a signed URL to download one attachment
- `shiptify.list_locations(limit=25, offset=0, q=None, internal_ref=None)` — List address-book locations — call before creating a SR to pick from/dest address ids
- `shiptify.list_carriers(internal_ref=None)` — List active carriers on the account
- `shiptify.list_shipment_modes()` — List shipment modes (road / sea / air / …) — call before create_shipment_request
- `shiptify.list_content_types()` — List cargo content types — call before any create_shipment_request* to resolve `type_id` on each cargo line
- `shiptify.list_quote_requests(limit=25, offset=0)` — List the quote requests received as a carrier (the RFQ inbox)
- `shiptify.galaxy_list_shipments(limit=25, offset=0, created_date_from=None, created_date_to=None, departure_date_min=None, departure_date_max=None, arrival_date_min=None, arrival_date_max=None)` — List shipments from the carrier's perspective — main tracking hub, ALWAYS date-filtered
- `shiptify.galaxy_get_shipment(id)` — Fetch one carrier-side shipment by id
- `shiptify.galaxy_list_tracking_points(id)` — List the tracking points (stops / events) of a carrier-side shipment
- `shiptify.galaxy_list_shipment_attachments(id)` — List attachments on a carrier-side shipment
- `shiptify.galaxy_list_shippers()` — List active shippers a carrier works with — carrier counterpart of list_carriers
- `shiptify.galaxy_get_attachment_download_url(id)` — Get a signed URL to download one attachment on a carrier-side shipment

## Write actions (require user approval — build with `.op()`)

- `shiptify.create_shipment_request.op(name, shipment_mode_id, reply_before, from_addresses, dest_addresses, accounting_entity_id=None, carrier_id=None, carrier_ids=None, comment=None, internal_note=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, total_linear_meters=None, measurement_system=None, contents=None)` — Create a new shipment request (booking)
- `shiptify.create_shipment_request_draft.op(name, shipment_mode_id=None, reply_before=None, from_addresses=None, dest_addresses=None, comment=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, contents=None)` — Create a draft shipment request (status: draft)
- `shiptify.update_shipment_request.op(id, name=None, accounting_entity_id=None, comment=None, internal_note=None, internal_ref=None, internal_name=None, total_volume=None, total_weight=None, total_linear_meters=None, measurement_system=None)` — Update fields of a shipment request
- `shiptify.cancel_shipment_request.op(id)` — Cancel a shipment request
- `shiptify.upload_shipment_request_attachment.op(id, attachments, carrier_id=None)` — Upload one or several files onto a shipment request
- `shiptify.send_shipment_request_message.op(id, message, carrier_id=None, sender_name=None, sender_email=None)` — Post a message in the booking chat of a shipment request
- `shiptify.confirm_shipment_pickup.op(id, date, time=None, comment=None, incident=None, cause_id=None)` — Confirm pickup of a shipment (creates the actual pickup point)
- `shiptify.confirm_shipment_delivery.op(id, date, time=None, comment=None, incident=None, cause_id=None)` — Confirm delivery of a shipment
- `shiptify.replan_shipment_pickup.op(id, date=None, time=None, comment=None, reason=None)` — Replan pickup of a shipment (new date / time)
- `shiptify.replan_shipment_delivery.op(id, date=None, time=None, comment=None, reason=None)` — Replan delivery of a shipment
- `shiptify.upload_shipment_attachment.op(id, attachments)` — Upload one or several files onto a shipment
- `shiptify.send_shipment_message.op(id, message, sender_name=None, sender_email=None)` — Post a message in the tracking chat of a shipment
- `shiptify.create_location.op(name, address_1, city, zipcode, country, type=None, address_2=None, state=None, recipient_name=None, company_name=None, email=None, phone_number=None, instructions=None, internal_ref=None, locode=None, contact=None)` — Create a new address-book location — use ONLY when list_locations returned no match
- `shiptify.galaxy_create_carrier_shipment_request.op(name, shipment_mode_id, reply_before, from_addresses, dest_addresses, shipper_id=None, shipper_internal_ref=None, other_reference=None, accounting_entity_id=None, comment=None, internal_ref=None, carrier_ids=None, pre_awarded=None, total_weight=None, total_volume=None, total_linear_meters=None, measurement_system=None, contents=None)` — Create a carrier-initiated shipment request (spot booking)
- `shiptify.galaxy_create_carrier_shipment_request_draft.op(name, shipment_mode_id=None, reply_before=None, shipper_id=None, from_addresses=None, dest_addresses=None, comment=None, internal_ref=None, other_reference=None, total_weight=None, total_volume=None, contents=None)` — Create a draft carrier-side shipment request
- `shiptify.galaxy_upload_shipment_request_attachment.op(id, attachments)` — Upload one or several files onto a carrier-side shipment request
- `shiptify.galaxy_send_shipment_request_message.op(id, message, sender_name=None, sender_email=None)` — Post a message in the booking chat of a carrier-side shipment request
- `shiptify.galaxy_cancel_quote_request.op(id)` — Cancel a quote request the carrier received
- `shiptify.galaxy_confirm_shipment_pickup.op(id, date, time=None, comment=None, incident=None)` — Confirm pickup of a carrier-side shipment (creates the actual pickup point)
- `shiptify.galaxy_confirm_shipment_delivery.op(id, date, time=None, comment=None, incident=None)` — Confirm delivery of a carrier-side shipment
- `shiptify.galaxy_replan_shipment_pickup.op(id, date=None, time=None, comment=None, reason=None)` — Replan pickup of a carrier-side shipment
- `shiptify.galaxy_replan_shipment_delivery.op(id, date=None, time=None, comment=None, reason=None)` — Replan delivery of a carrier-side shipment
- `shiptify.galaxy_confirm_shipment.op(id, date=None, time=None)` — Confirm the whole shipment (distinct from per-leg pickup / delivery)
- `shiptify.galaxy_cancel_shipment.op(id, comment=None)` — Cancel a carrier-side shipment
- `shiptify.galaxy_upload_shipment_attachment.op(id, attachments)` — Upload one or several files onto a carrier-side shipment
- `shiptify.galaxy_send_shipment_message.op(id, message, sender_name=None, sender_email=None)` — Post a message in the tracking chat of a carrier-side shipment
- `shiptify.galaxy_confirm_tracking_point.op(id, date=None, time=None, comment=None, incident=None)` — Confirm a single tracking point (transit stop, customs, …) of a carrier-side shipment
- `shiptify.galaxy_replan_tracking_point.op(id, date=None, time=None, comment=None, reason=None)` — Replan a single tracking point of a carrier-side shipment
- `shiptify.galaxy_cancel_tracking_point.op(id, comment=None)` — Cancel a single tracking point of a carrier-side shipment
- `shiptify.galaxy_update_tracking_point_location.op(id, address_id, tracking_point_id=None)` — Move a tracking point of a carrier-side shipment to a different address

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `ShipmentRequest` — `id: int`, `internal_ref?: str`, `name: str`, `status: str`, `shipment_mode_id?: int`, `reply_before?: str`, `total_weight?: float`, `total_volume?: float`, `total_linear_meters?: float`, `comment?: str`, `created_at?: str`
- `Shipment` — `id: int`, `code?: str`, `status?: str`, `tracking_code?: str`, `name?: str`, `internal_ref?: str`, `other_reference?: str`, `shipper_id?: int`, `carrier_id?: int`, `shipper_name?: str`, `sh_request_id?: int`, `quote_request_id?: int`, `total_weight?: float`, `total_volume?: float`, `total_linear_meters?: float`, `weight?: str`, `cost?: str`, `goods_value?: str`, `co2_amount?: float`, `date?: str`, `estimated_departure_time?: str`, `real_departure_time?: str`, `estimated_arrival_time?: str`, `real_arrival_time?: str`, `created_at?: str`, `archived_carrier?: bool`, `archived_shipper?: bool`, `shipment_mode?: str`, `shiptify_private_link?: str`, `shiptify_public_link?: str`
- `TrackingPoint` — `id: int`, `shipment_id?: int`, `type?: str`, `code?: str`, `position?: int`, `address_id?: int`, `planned_date?: str`, `planned_time?: str`, `real_date?: str`, `real_time?: str`, `incident?: str`, `comment?: str`
- `Attachment` — `id: int`, `name: str`, `type?: str`, `status?: str`
- `Location` — `id: int`, `name: str`, `internal_ref?: str`, `recipient_name?: str`, `address_1?: str`, `address_2?: str`, `city?: str`, `state?: str`, `zipcode?: str`, `country?: str`, `type?: str`
- `Carrier` — `id: int`, `name: str`, `code?: str`, `scac?: str`, `internal_ref?: str`
- `ShipmentMode` — `id: int`, `name: str`
- `ContentType` — `id: int`, `name: str`, `length?: float`, `width?: float`, `height?: float`, `weight?: float`, `dimension_unit?: str`, `weight_unit?: str`, `is_container?: bool`, `iso_container_type?: str`, `for_road?: bool`, `for_sea?: bool`, `for_air?: bool`, `for_rail?: bool`, `for_express?: bool`, `for_groupage?: bool`, `for_courier?: bool`, `for_air_sea?: bool`, `for_ro_ro?: bool`, `for_river?: bool`
- `WriteResult` — `id?: int`, `internal_ref?: str`, `successful?: bool`
- `AttachmentDownload` — `url: str`
- `QuoteRequest` — `id: int`, `sh_request_id?: int`, `carrier_id?: int`, `status?: str`, `is_read?: bool`, `reply_before?: str`, `shipment_mode_id?: int`, `cost?: str`, `currency_code?: str`, `date_departure?: str`, `date_arrival?: str`, `shipment_request?: dict`, `price_details?: list[dict]`
- `GalaxyShipper` — `id: int`, `name: str`, `account_id?: int`

## Route by the connection's account role

Every Shiptify connection carries an `account_type` (`shipper` or `carrier`) in the `<external_apps>` block. Read it before picking an action — a mismatch returns `403 "User is not <role>"`, and retrying the same family never helps.

| Need                              | `shipper`                                                                          | `carrier`                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Track shipments                   | `list_shipments`                                                                   | `galaxy_list_shipments`                              |
| One shipment / its stops          | `get_shipment`, `list_tracking_points`                                             | `galaxy_get_shipment`, `galaxy_list_tracking_points` |
| Confirm / replan pickup, delivery | `confirm_*`, `replan_*`                                                            | `galaxy_confirm_*`, `galaxy_replan_*`                |
| Attachments, messages             | `list_shipment_attachments`, `upload_shipment_attachment`, `send_shipment_message` | the `galaxy_` twins                                  |
| Book transport                    | `create_shipment_request`                                                          | `galaxy_create_carrier_shipment_request`             |
| Incoming work                     | `list_shipment_requests` (own bookings)                                            | `list_quote_requests` (RFQ inbox)                    |
| Counterparties                    | `list_carriers`                                                                    | `galaxy_list_shippers`                               |

`list_locations`, `create_location`, `list_shipment_modes` and `list_content_types` serve both roles. `list_carriers`, `list_shipment_requests` and everything under `/orders`, `/invoices`, `/events` are shipper-only.

On a carrier connection, `galaxy_list_shipments` spans every account the key reaches; `list_shipments` answers too but only for the one account the key was issued on. Prefer the `galaxy_` one, or a shipment from a sister agency will look like it does not exist.

**`galaxy_list_shipments` returns OLDEST first — always pass `created_date_from`.** Unfiltered it answers with the account's first-ever shipments, which can be years old, and paging never reaches today. `list_shipments` is the opposite (newest first), so this is a carrier-only trap.

```python
from datetime import date, timedelta
recent = shiptify.galaxy_list_shipments(
    created_date_from=(date.today() - timedelta(days=30)).isoformat(), limit=100
)
```

## Content types are a big catalogue — filter, never print

`list_content_types()` returns the platform-wide list (over a thousand rows). Filter it in Python by mode flag and name, keep the one id you need, and never print the list.

```python
ctypes = shiptify.list_content_types()
pallet = next(c for c in ctypes if c.for_road and "pallet" in c.name.lower())
c40hc = next(
    c for c in ctypes
    if c.for_sea and (c.iso_container_type or "").upper().startswith("40")
)
```

## Creating a shipment request

Resolve the lookups first, then submit one plan. Four things Shiptify rejects, on both the shipper and the carrier variant:

- **A stop without `date_from`** (`YYYY-MM-DD`) on `from_addresses` / `dest_addresses` — the whole address fails validation with `"does not match any of the allowed types"`. Only the `*_draft` variants accept a stop without one. Pick a plausible date and surface it in the approval card.
- **`reply_before` with a timezone** — send `2026-06-10T18:00:00`, no `Z`, no `+02:00`. A request mapper strips the suffix defensively; emitting the right form keeps the approval card readable.
- **A `contents[i]` line without a valid `type_id`** — resolve it from `list_content_types()`. `quantity` is required too.
- **Per-line volume** — there is no `m3` / `volume_m3` on a cargo line, and unknown fields are dropped silently. Aggregate to the top-level `total_volume`.

Inline addresses (`address_1, city, country, zipcode, date_from`) work, but validation is strict — prefer `create_location` + `address_id`.

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
        reply_before="2026-06-10T18:00:00",
        from_addresses=[{"address_id": origins[0].id, "date_from": "2026-06-12"}],
        dest_addresses=[{"address_id": dests[0].id, "date_from": "2026-06-13"}],
        total_weight=820.0,
        contents=[{"type_id": pallet.id, "quantity": 2, "weight": 410}],
    ),
])
```

The carrier variant is the same shape plus a `shipper_id` from `galaxy_list_shippers()`, and takes `other_reference` for the customer's own order number. When cargo ships as one container, emit ONE `contents` line for the container — not one per SKU; per-SKU detail belongs in `comment` or an attachment.

## Creating a location takes two turns

If `list_locations(q=...)` finds no match, `create_location` — but the new id only exists after the user approves, so book against it in the NEXT turn.

```python
# Turn 1
if not shiptify.list_locations(q="ACME Bordeaux DC"):
    run_plan([
        shiptify.create_location.op(
            name="ACME Bordeaux DC", address_1="12 rue de la Logistique",
            zipcode="33000", city="Bordeaux", country="FR",
            type="warehouse", internal_ref="ACME-BX-01",
        ),
    ])

# Turn 2 — re-fetch, then use matches[0].id in the booking.
matches = shiptify.list_locations(q="ACME Bordeaux DC")
```

Create one only when nothing fits — duplicates in the address book are the user's cleanup. Ask when a near-match is ambiguous.

## Carrier — the RFQ inbox

`list_quote_requests()` returns each request with its price lines already embedded (`price_details`, `price` null until quoted) and the parent request under `shipment_request`. No second read is needed to see what is being asked.

```python
inbox = shiptify.list_quote_requests(limit=25)
pending = [q for q in inbox if q.status == "new"]
for q in pending:
    print(q.shipment_request.name, q.reply_before,
          [d.name for d in (q.price_details or [])])
```

## Confirming and replanning

`confirm_*` records what actually happened; `replan_*` moves a planned date. Both are writes and go through `run_plan`. Set `incident` only when something went wrong — `Customs clearance`, `Strike`, `Truck incident`, `Waiting at pick up place` — and omit it when the stop is on time.

For a carrier, `galaxy_confirm_tracking_point` / `galaxy_replan_tracking_point` act on ONE stop of a multi-leg journey; the shipment-level `galaxy_confirm_shipment_pickup` / `_delivery` act on the first and last.

## Attachments

`documentType` is a strict enum — pick the slug from the action description (`bill_of_lading`, `cmr`, `proof_of_delivery`, `invoice`, `awb`, `customs`, `claim`, `other`, …). Pass the file as `base64Data`, or as a `url` Shiptify can fetch.

```python
run_plan([
    shiptify.upload_shipment_attachment.op(
        id=812345,
        attachments=[{
            "fileName": "POD_812345.pdf",
            "documentType": "proof_of_delivery",
            "base64Data": pdf_b64,
        }],
    ),
])
```

Reading one back: `get_attachment_download_url(id=...)` returns a short-lived signed URL — `galaxy_get_attachment_download_url` on a carrier connection.

## Several Shiptify connections

When the team connected more than one account, `<external_apps>` lists each with its `connection_id` and `account_type`. Pass `connection_id="<uuid>"` to any action to pick one, and route on `account_type` — NEVER on the display name. Never ask the user to choose when the block already disambiguates.

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write: `run_plan([ shiptify.create_shipment_request.op(name="…", shipment_mode_id=1, reply_before="…", …) ])`
- Many writes: `run_plan([ shiptify.<action>.op(...), ... ])`

`run_plan` raises `fretik_apps.ApprovalPending`. This is EXPECTED — not an
error. Stop there. Never wrap it in `try/except` (that hides the approval
card), and never `print` the ops as a preview instead of calling it — no
call, no plan.

Once the user decides, the outcome replaces that same tool result. It covers
only the operations it lists: if any code sat AFTER the `run_plan` call,
re-run the identical cell — approved plans replay from cache and never execute
twice. On rejection you get their feedback — adapt and write new code.

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

- Every write of the turn goes in ONE `run_plan`. A second call in the
  same cell is lost: the first raises and the rest of the cell never runs.
- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- A plan may mix actions from several apps — one approval for all of them.
- Partial failures come back per-op; re-submit a `run_plan` with only
  the failed ops.
