## What Xtent models

Akanea WMS (Xtent) runs a physical warehouse on behalf of one or more **warehouse customers** — `client_code_id`, shown as _stockeur_ in the French UI. Two flows carry everything:

- **Receptions** — goods coming IN: a header plus lines, then received, put away, validated.
- **Preparations** — picking orders going OUT to a **consignee** (`consignee_code_id`).

Around them sit **items** (the article catalogue) and **parties** (suppliers, consignees, carriers, warehouse customers). Quantities are counted in sale units (UVC), parcels and full pallets.

Two things about calling it. Its **provider key is `akanea-wms`** — that spelling, wherever a tool asks for an app by key; `akanea_wms` is only the Python module's name. And each call **leases a licence seat** (the token is acquired and released server-side, so never look for a login action): calls on one connection are queued for you rather than run at once, so a burst is slower than a single call, never a pile of failures.

**Parties have no read action, and none can be added — Xtent publishes none.** A party reaches you only as a side-car on the record that references it: `client_code_id` + `client_name` on items, stock quantities and movements, `supplier_name` on receptions, `consignee_name` and `carrier_name` on preparations. To turn a name on a document into a `client_code_id`, look up one of its item codes with `list_items` and read the pair off the item. Do not go looking for a `list_parties`, and do not introspect the Python module for one.

## Filters and sorts

Every read takes a `filters` string over the entity's PascalCase properties. Always pass one — an unfiltered read scans the whole warehouse.

- Comparison: `ItemCode="AAA-01"`, `Id=1`, `SalesUnit>=10`, `StatusId!="BLQ"` — strings take DOUBLE quotes.
- Text: `SupplierName.Contains("Dupont")`, `.StartsWith(…)`, `.EndsWith(…)`.
- Presence: `BatchNumber != null`, `ValidationDate = null`.
- Dates: `DateTime(2026,1,31)`, `DateTime(2026,1,31,10,23,45)`, `DateTime.Now`, `DateTime.ToDay`, `DateTime.ToDay.AddDays(-7)`, `DateTime.ToDay.FirstDayOfMonth()`.
- Combine with `and` / `or`; reach into a relation with a dot (`Client.Name="ACME"`); test a collection with `EdiReceptionDetailsList.Count(ItemCode="AAA-01")>=1`.

`sorts` is comma-separated: `"Id desc"`, `"ItemCode asc,Id desc"`.

```python
# Stock of one item, largest quantity first
akanea_wms.get_item_quantities(filters='ItemCode="AAA-ALK-X4"', sorts="SURealStock desc")

# Receptions expected within a week and not yet validated
akanea_wms.list_receptions(
    filters="DateOfPlannedReceiving>=DateTime.ToDay "
            "and DateOfPlannedReceiving<=DateTime.ToDay.AddDays(7) "
            "and ValidationDate=null",
)

# Preparations past their delivery date
akanea_wms.list_preparations(
    filters="PlannedDeliveryDate<DateTime.ToDay and ValidationDate=null",
)
```

## Patterns

### Read stock and real progress

`get_item_quantities` returns one row per item / batch / pallet. Quote availability from `su_available` (real stock minus running preparations and pending put-away), never from `su_real_stock`, which counts goods already promised elsewhere.

Header reads — `list_receptions`, `list_preparations` — say what was ANNOUNCED. What the floor actually did lives in `list_receptions_stored` and `list_preparations_prepared` (one row per stock object), plus `list_preparations_sscc` for pallet labels. When a user asks "did it really arrive / really ship", read the second set.

Every read caps its answer at `limit` rows (200 by default) because Xtent pages nothing server-side. `limit` truncates what comes BACK to you; it does not shrink the query, so lowering it makes a broad read no faster and no cheaper — only `filters` does. An unfiltered read of a real warehouse takes over a minute and will time out. A truncated answer means the filter was too broad — narrow `filters` instead of raising `limit`.

Dates come back as the warehouse's own wall clock, with no timezone (`2026-08-05T15:30:03`). Report them as-is; do NOT convert them or append `Z`.

### Submit an integration, then verify it

Xtent integrates asynchronously: an accepted call only means the payload was queued. `upsert_*` and `change_stock` hand back `flow_ids` (plus `entity_ids` when Xtent echoes them), and the flow is confirmed only by a `check_flow_status` call made AFTER the write has executed — never in the same script.

```python
akanea_wms.upsert_receptions.op(receptions=[{
    "client_code_id": "246",
    "movement_code_id": "ENT",
    "supplier_name": "Dupont SA",
    "planned_receiving_date": "2026-08-12",
    "lines": [
        {"line_number": 1, "item_code": "AAA-ALK-X4", "expected_sale_units": 120},
        {"line_number": 2, "item_code": "BBB-LR6-X8", "expected_sale_units": 60},
    ],
}])
```

Once that write has run, verify with the ids it returned:

```python
status = akanea_wms.check_flow_status(flow_id=8412)
# flow_status "OK" → integrated; "KO" → read status.errors and fix the payload
akanea_wms.check_entity_integration(entity_type="Reception", entity_ids=[91204])
# status "OK" usable · "KO INTEGRATION" never created · errors listed otherwise
```

`check_entity_integration` needs Xtent ids: use `entity_ids` from the write's result, or ids read from `list_receptions` / `list_preparations`.

Pass `id` on a reception or preparation to update it; omit `id` to create a new one.

## Payload fields

Only the fields listed here reach Xtent — anything else is dropped before the call. Dates are plain strings (`"2026-08-12"`), booleans are real booleans. Required fields are starred.

- **reception** — `client_code_id`\*, `movement_code_id`\*, `lines`\*, `id`, `order_reference`, `supplier_code_id`, `supplier_name`, `supplier_reference`, `carrier_code_id`, `carrier_name`, `planned_receiving_date`, `appointment_date`, `arrival_date`, `reception_warehouse_id`, `office_id`, `truck_number`, `container_number`, `seal`, `number_of_pallets`, `number_of_parcels`, `comments`
- **reception line** — `line_number`\*, `item_code`\*, `expected_sale_units`\*, `internal_item_id`, `batch_number`, `expiry_date`, `expected_parcels`, `expected_full_pallets`, `gross_weight`, `net_weight`, `status_code_id`, `external_line_number`, `comments`
- **preparation** — `client_code_id`\*, `consignee_code_id`\*, `lines`\*, `comments`, `id`, `order_reference`, `client_reference`, `consignee_reference`, `consignee_name`, `consignee_address1`, `consignee_address2`, `consignee_zip_code`, `consignee_city_name`, `consignee_country_id`, `contact_name`, `contact_phone`, `contact_mail`, `carrier_code_id`, `carrier_name`, `planned_delivery_date`, `imperative_delivery_date`, `planned_preparation_date`, `preparation_warehouse_id`, `movement_code_id`, `office_id`, `urgent`
- **preparation comment** (up to 3 in `comments`) — `comment_type`\*, `comment`, `order`. The type routes the note: `PRE` reaches the picker, `TRS` the carrier, `LIV` the delivery slip, `REC` the reception. A note with no type has nowhere to go, so pick one deliberately rather than defaulting.
- **preparation line** — `line_number`\*, `item_code`\*, `ordered_sale_units`\*, `internal_item_id`, `batch_number`, `ordered_parcels`, `ordered_full_pallets`, `expiry_date`, `status_code_id`, `external_line_number`, `comments`
- **item** — `client_code_id`\*, `item_code`\*, `description`\*, `priority_racks`\* (each: `warehouse_id`\*, `movement_type`\*, `priority_rack`, `priority`), `external_reference`, `family_code`, `packaging_code`, `unit_code`, `supplier_code_id`, `batch_management`, `available`, `inner`, `outer`, `layers_per_pallet`, `parcels_per_layer`, `parcel_gross_weight`, `parcel_net_weight`, `comments`
- **party** — `id`\*, `name`, `party_category`, `office_id`, `address1`, `address2`, `zip_code`, `city_name`, `country_id`, `operation_address1`, `operation_address2`, `operation_zip_code`, `operation_city_name`, `operation_country_id`, `email`, `phone_number`, `siret`, `vat_identification`, `eori_number`, `available`
- **stock change** — `client_code_id`, `item_code`, `item_id`, `pallet_number`, `batch_number`, `location_id`, `movement_code`, `movement_type`, `movement_date`, `unit_qty`, `sales_unit`, `parcels`, `full_pallets`, `status_id`, `expiry_date`, `fifo_date`, `instruction_type`, `instruction_date`, `stock_modification_label`

Enumerations: `movement_type` — `ENT` reception, `SOR` preparation, `TRA` transfer, `RET` return, `KIT` kit. `party_category` — `F` supplier, `D` consignee, `S` warehouse customer, `T` carrier. `batch_management` — `L` free, `I` imposed.

Codes are configured per install: `client_code_id`, `movement_code_id`, `status_code_id`, warehouse and office ids differ between customers. Resolve them from existing data (`list_items`, `list_receptions`, `list_preparations`) or ask the user — NEVER invent one.

`change_stock` only reaches stock whose reception is already validated; identify the stock object by `client_code_id` plus `pallet_number` and/or `item_code`.

### Multiple connected warehouses

When several Akanea WMS connections exist, the `<external_apps>` block lists each with its `connection_id`. Pass `connection_id="<uuid>"` to target one; never prompt the user when that block already disambiguates.
