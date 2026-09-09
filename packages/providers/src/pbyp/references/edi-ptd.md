# EDI and partner gateways (PTD)

A gateway is a standing link between one Pbyp entity and one outside system. PTD is one; Shiptify is another. The mechanism is the same for all of them.

## The model

`gateway_external` — one row per (entity, partner):

| Column          |                                                                     |
| --------------- | ------------------------------------------------------------------- |
| `gateway_type`  | → `external_reference_types`. Today: **1 = PTD**, **2 = Shiptify**  |
| `external_code` | the partner's own code for this entity                              |
| `entity_id`     | the Pbyp entity the gateway serves                                  |
| `user`          | the account the partner authenticates as                            |
| `access_key`    | that account's static token — **stripped from every response here** |

`list_gateways()` returns them without the key. Creating one (`create_gateway`) provisions the partner account as well, which is why it goes through an endpoint rather than `/items`.

## The partner PULLS; Pbyp never pushes

There is no outbound call. The partner polls four routes with its own token:

```
GET /edi-endpoints/getOrders   |  getFolders  |  getBookings  |  getEvents
POST /edi-endpoints/orderValidation | folderValidation | bookingValidation | eventValidation   {"ids": [...]}
```

Each `get*` returns the objects whose journal row matches, for the caller's own gateway:

- `receive_validation = false` — not yet acknowledged;
- `is_updated = false` by default, `true` with `?update=true` — first export versus re-export;
- `date_created >= one month ago` — **a journal row older than a month is never served again**, acknowledged or not;
- and the object itself must be `status: "published"`.

The partner then POSTs the journal ids it processed to the matching `*Validation` route, which sets `receive_validation: true`. That is the whole handshake.

## Transferring an object = creating its journal row

The four journals, and the column that names the object:

| Journal       | Column                               | For         |
| ------------- | ------------------------------------ | ----------- |
| `orders_edi`  | `order_id`                           | an order    |
| `folder_edi`  | `sea_folder_id` \| `air_folder_id`   | a folder    |
| `booking_edi` | `sea_booking_id` \| `air_booking_id` | a voyage    |
| `event_edi`   | `event_id` (+ `external_reference`)  | a milestone |

`transfer_to_gateway()` writes exactly:

```json
{
  "<object>_id": 42,
  "gateway_external_id": 7,
  "is_pbyp_export": true,
  "is_updated": false,
  "receive_validation": false
}
```

The quadruplet means: ours to send, first export, not yet acknowledged. Nothing else creates that first row — **the hooks only ever re-export an object that already has one**. So an object nobody transferred is invisible to the partner forever, however complete it is.

## What the hooks do afterwards

Once a journal row exists, Pbyp keeps the partner current on its own:

- Updating the object writes a second journal row with `is_updated: true, receive_validation: false`, so the partner picks up the change on its `?update=true` poll.
- The re-export **clones the gateway of row `[0]`** — the first one created. An object enrolled with two partners is therefore re-exported to one of them only. If two gateways must both stay current, create a row per gateway yourself on every change.
- New events fan out to every gateway whose journal row has `receive_validation: true`, i.e. gateways already in a working exchange. For an order or a folder there is an extra condition: an `external_references` row of that gateway's type must exist on the object. Without it the events are silently not propagated — this is the most common "PTD is not receiving anything" cause after a missing first transfer.

## Preconditions before transferring

1. The object is `status: "published"`. An archived one is filtered out of every pull.
2. The gateway belongs to an entity in your scope — `list_gateways()` only returns those.
3. For events to follow: the object carries an `external_references` row whose `type` is the gateway's `gateway_type`, and `is_main: true` if it should also become `main_external_reference`.
4. It is not already enrolled with that gateway — check first, a second row is a duplicate export.

```python
gw = next(g for g in pbyp.list_gateways() if g.gateway_label == "PTD")
existing = pbyp.query_items(
    collection="folder_edi",
    filter={"sea_folder_id": {"_eq": folder.id}, "gateway_external_id": {"_eq": gw.id}},
    fields=["id", "is_updated", "receive_validation"],
)
if not existing["items"]:
    pbyp.transfer_to_gateway(object="sea_folder", object_id=folder.id, gateway_id=gw.id).op()
```

## Checking what a partner has seen

The journal is readable:

```python
pbyp.query_items(
    collection="folder_edi",
    filter={"gateway_external_id": {"_eq": gw.id}},
    fields=["id", "sea_folder_id", "air_folder_id", "is_updated",
            "receive_validation", "date_created"],
    sort=["-date_created"], limit=50,
)
```

- `receive_validation: false` and recent → queued, the partner has not collected it yet.
- `receive_validation: false` and older than a month → **it will never be collected**; create a fresh row.
- `receive_validation: true` → acknowledged.

## Transcoding

The partner's codes are not Pbyp's. Four per-entity tables translate, and a missing entry means the field is simply **omitted** from the export — no error, no warning:

| Table                          | Translates                                           |
| ------------------------------ | ---------------------------------------------------- |
| `external_reference_address`   | an `address_book` entry ↔ the partner's address code |
| `external_reference_companies` | a carrier ↔ the partner's carrier code               |
| `external_reference_terminals` | a port or airport ↔ the partner's terminal code      |
| `external_event_code`          | a Pbyp event type ↔ the partner's milestone code     |

Each row carries `external_reference_types_id`, so the same object can map differently per partner. When a partner reports a field as blank, look here before looking at the object.

## `external_references` on the object

Distinct from the journal: this is the partner's reference **for the shipment** (`reference` **R**, `type` **R** → `external_reference_types`, `is_main`). `main_external_reference` on the order or folder mirrors whichever row has `is_main: true`, and searches match on it.

## Endpoints that answer 200 with an error body

The `/edi-endpoints/*` routes report failures inside a 200 response (`{"status": "error"}`), a Directus-extension habit rather than a design. Read the body, not the status code — this is the same shape as the event deduplication and it is easy to mistake for a success.
