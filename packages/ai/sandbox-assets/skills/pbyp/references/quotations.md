# Quotations

A quotation prices a shipment before it exists. It carries the same route, parties and cargo as a folder, plus charge lines, and can be converted into a real shipment once accepted.

## The two sides

`client` and `freight_forwarder` are both stored, and both are NOT NULL — but you only supply **one**. A hook reads `entity_id`'s `is_client` and fills your own side; `create_quotation(counterparty=…)` names the other. So:

- you are a **freight forwarder** → `counterparty` is the client entity;
- you are a **client** → `counterparty` is the forwarder entity you are asking.

Both sides can read the quotation and act on it — this is the one family where a share is not read-only, because both parties are principals. **Purchase prices are not shared**: `quotations_quotes` rows of `type: "purchases"` are filtered out server-side for the client, and `margin` belongs to the owner.

## Required on create

`number`, `entity_id`, `transport_type` (`sea` \| `air`), `booking_type` (`import` \| `export`), `incoterm`, `margin`, `shipper`, `consignee`, `departure_terminal`, `arrival_terminal`, `etd`, `eta`, and the counterparty. A quotation with an open route is not representable — pick the terminals before calling.

`number` comes from `next_quotation_number()`: `Q<entity_id><YYYYMM><NNNN>`.

## Status workflow

`quotation_status` — required, and the only field `set_quotation_status()` touches:

```
DRAFT ──┬─► TRANSFERRED_TO_CLIENT              (a forwarder sends its price)
        └─► TRANSFERRED_TO_FREIGHT_FORWARDER   (a client asks for one)
                        │
                        ├─► ACCEPTED
                        └─► DECLINED
CANCELED  — reachable from anywhere
```

There are two distinct transferred states, one per direction. Sending `TRANSFERRED_TO_CLIENT` from a client account is meaningless, not an error — check `whoami().is_client` before choosing.

`ACCEPTED` and `DECLINED` are the receiving side's to set. Setting them on your own quotation records an outcome you were told about; it does not notify anyone.

## Charge lines

`quotations_quotes`, one row per charge:

| Field                                     |                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `code` **R**                              | the charge code                                                     |
| `name`                                    | label                                                               |
| `type` **R**                              | `purchases` (what you pay) \| `sales` (what you invoice)            |
| `currency` **R**, `amount_currency` **R** | the line as agreed                                                  |
| `conversion_rate` **R**                   | to the entity's own currency                                        |
| `amount_default_entity_currency` **R**    | `amount_currency × conversion_rate`, computed by `create_quotation` |

Never total mixed `amount_currency` values. Sum `amount_default_entity_currency`, which is in `entities.default_currency`.

`quotations_quotes_templates` (+ `_quotes`) hold reusable line sets per entity — read one and copy its lines rather than retyping a tariff.

## Cargo and sub-orders

Two levels, and they are not interchangeable:

- `quotations_parcels` — cargo priced at the quotation level, for a single consignment.
- `quotations_orders` — sub-orders inside the quotation, each with its own `number`, `shipper`, `consignee` (all required) and its own `quotations_orders_parcels` lines. Used when one price covers several consignments.

`parcels_link_type` (`folder` \| `order`) says which level the cargo hangs off. `quotations_containers` prices container slots.

## Conversion

`generated` flips to `true` once the quotation has produced a shipment. The conversion is not one call — it is the ordinary creation sequence, in this order, in separate turns:

1. `create_sea_booking` / `create_air_booking` for the voyage.
2. `create_folder` with `voyage_id` set to it, and the quotation's parties, incoterm and terminals.
3. `create_order` per `quotations_orders` row, attached to the folder.
4. `update_items("quotations", ids=[q.id], data={"generated": True})`.

Copy the cargo lines across explicitly; nothing links a quotation's parcels to a folder's. The PDF (`pdf`) is produced by the Pbyp interface, not through the API — an accepted quotation with no PDF is normal.
