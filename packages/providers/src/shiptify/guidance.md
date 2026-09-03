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
