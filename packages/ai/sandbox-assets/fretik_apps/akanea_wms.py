# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Akanea WMS provider — 15 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


# ── Types ─────────────────────────────────────────────────────────

class ItemQuantity(BaseModel):
    item_code: str | None = None
    client_code_id: str | None = None
    batch_number: str | None = None
    pallet: str | None = None
    warehouse_id: str | None = None
    status_id: str | None = None
    expiry_date: str | None = None
    fifo_date: str | None = None
    su_available: float | None = None
    su_real_stock: float | None = None
    su_reserved: float | None = None
    su_blocked: float | None = None
    su_stored: float | None = None
    parcels_available: float | None = None
    parcels_real_stock: float | None = None
    full_pallets_available: float | None = None
    full_pallets_real_stock: float | None = None
    gross_weight: float | None = None
    net_weight: float | None = None


class StockMovement(BaseModel):
    id: int | None = None
    item_code: str | None = None
    client_code_id: str | None = None
    movement_code: str | None = None
    movement_type: str | None = None
    movement_date: str | None = None
    creation_date: str | None = None
    batch_number: str | None = None
    pallet_number: str | None = None
    location_id: str | None = None
    status_id: str | None = None
    sales_unit: float | None = None
    unit_qty: float | None = None
    parcels: float | None = None
    full_pallets: float | None = None
    reception_id: int | None = None
    preparation_id: int | None = None


class Reception(BaseModel):
    id: int | None = None
    client_code_id: str | None = None
    order_reference: str | None = None
    movement_code_id: str | None = None
    order_status: str | None = None
    supplier_name: str | None = None
    supplier_reference: str | None = None
    carrier_name: str | None = None
    planned_receiving_date: str | None = None
    actual_receiving_date: str | None = None
    appointment_date: str | None = None
    arrival_date: str | None = None
    reception_warehouse_id: str | None = None
    truck_number: str | None = None
    number_of_lines: float | None = None
    number_of_pallets: float | None = None
    number_of_parcels: float | None = None
    number_of_sale_units: float | None = None
    creation_date: str | None = None
    validation_date: str | None = None


class Preparation(BaseModel):
    id: int | None = None
    client_code_id: str | None = None
    order_reference: str | None = None
    client_reference: str | None = None
    consignee_reference: str | None = None
    order_status: str | None = None
    consignee_name: str | None = None
    consignee_city_name: str | None = None
    consignee_country_id: str | None = None
    carrier_name: str | None = None
    planned_delivery_date: str | None = None
    imperative_delivery_date: str | None = None
    planned_preparation_date: str | None = None
    actual_preparation_date: str | None = None
    preparation_warehouse_id: str | None = None
    urgent: bool | None = None
    number_of_lines: float | None = None
    number_of_pallets: float | None = None
    number_of_parcels: float | None = None
    number_of_sale_units: float | None = None
    creation_date: str | None = None
    validation_date: str | None = None


class StockLine(BaseModel):
    reception_id: int | None = None
    preparation_id: int | None = None
    item_code: str | None = None
    batch_number: str | None = None
    pallet_number: str | None = None
    location_id: str | None = None
    status_id: str | None = None
    sales_unit: float | None = None
    parcels: float | None = None
    full_pallets: float | None = None
    gross_weight: float | None = None
    net_weight: float | None = None
    expiry_date: str | None = None
    movement_date: str | None = None


class SsccLine(BaseModel):
    preparation_id: int | None = None
    sscc: str | None = None
    pallet_number: str | None = None
    item_code: str | None = None
    batch_number: str | None = None
    sales_unit: float | None = None
    parcels: float | None = None


class Item(BaseModel):
    id: int | None = None
    item_code: str | None = None
    client_code_id: str | None = None
    description: str | None = None
    external_reference: str | None = None
    family_code: str | None = None
    packaging_code: str | None = None
    unit_code: str | None = None
    supplier_code_id: str | None = None
    batch_management: str | None = None
    available: bool | None = None
    inner: float | None = None
    outer: float | None = None
    layers_per_pallet: float | None = None
    parcels_per_layer: float | None = None
    parcel_gross_weight: float | None = None
    parcel_net_weight: float | None = None


class FlowStatus(BaseModel):
    errors: list[str]
    flow_id: int | None = None
    flow_status: str | None = None
    flow_type: str | None = None
    non_integrated_count: int | None = None


class EntityIntegrationStatus(BaseModel):
    errors: list[str]
    entity_id: int | None = None
    status: str | None = None
    flow_id: int | None = None


class IntegrationResult(BaseModel):
    flow_ids: list[int]
    entity_ids: list[int]
    references: list[str]
    errors: list[str]
    accepted_count: int | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class GetItemQuantitiesArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListStockMovementsArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListItemsArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListReceptionsArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListReceptionsStoredArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListPreparationsArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListPreparationsPreparedArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class ListPreparationsSsccArgs(BaseModel):
    filters: str | None = None
    sorts: str | None = None
    limit: int | None = 200


class CheckFlowStatusArgs(BaseModel):
    flow_id: int


class CheckEntityIntegrationArgs(BaseModel):
    entity_type: Literal["Reception", "Preparation", "Item", "Party"]
    entity_ids: list[int]


class UpsertReceptionsArgs(BaseModel):
    receptions: list[dict[str, Any]]


class UpsertPreparationsArgs(BaseModel):
    preparations: list[dict[str, Any]]


class UpsertItemsArgs(BaseModel):
    items: list[dict[str, Any]]


class UpsertPartiesArgs(BaseModel):
    parties: list[dict[str, Any]]


class ChangeStockArgs(BaseModel):
    stock_changes: list[dict[str, Any]]


# ── Read actions (eager — execute immediately) ─────────

def get_item_quantities(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[ItemQuantity]:
    """List stock on hand per item, batch and pallet

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetItemQuantitiesArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.get_item_quantities", _args)
    return [ItemQuantity(**item) for item in data]


def list_stock_movements(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[StockMovement]:
    """List internal stock movements

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListStockMovementsArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_stock_movements", _args)
    return [StockMovement(**item) for item in data]


def list_items(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[Item]:
    """List item master records

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListItemsArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_items", _args)
    return [Item(**item) for item in data]


def list_receptions(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[Reception]:
    """List inbound receptions

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListReceptionsArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_receptions", _args)
    return [Reception(**item) for item in data]


def list_receptions_stored(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[StockLine]:
    """List the stock actually put away for receptions

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListReceptionsStoredArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_receptions_stored", _args)
    return [StockLine(**item) for item in data]


def list_preparations(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[Preparation]:
    """List outbound preparation orders

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPreparationsArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_preparations", _args)
    return [Preparation(**item) for item in data]


def list_preparations_prepared(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[StockLine]:
    """List the stock actually picked for preparations

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPreparationsPreparedArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_preparations_prepared", _args)
    return [StockLine(**item) for item in data]


def list_preparations_sscc(
    filters: str | None = None,
    sorts: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[SsccLine]:
    """List SSCC pallet labels of preparations

    filters: Xtent filter over the entity's PascalCase properties — e.g. `ItemCode="AAA-01"`, `CreationDate>=DateTime(2026,1,1) and CreationDate<DateTime(2026,2,1)`, `SupplierName.Contains("Dupont")`. Strings take double quotes. Always filter: an unfiltered call scans the whole warehouse. Full syntax in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPreparationsSsccArgs(filters=filters, sorts=sorts, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.list_preparations_sscc", _args)
    return [SsccLine(**item) for item in data]


def check_flow_status(
    flow_id: int,
    connection_id: str | None = None,
) -> FlowStatus:
    """Check whether an integration flow was accepted

    flow_id: Flow id returned by an upsert_* / change_stock call. Check it on a LATER turn — integration is asynchronous.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = CheckFlowStatusArgs(flow_id=flow_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.check_flow_status", _args)
    return FlowStatus(**data)


def check_entity_integration(
    entity_type: Literal["Reception", "Preparation", "Item", "Party"],
    entity_ids: list[int],
    connection_id: str | None = None,
) -> list[EntityIntegrationStatus]:
    """Check the integration status of submitted entities

    entity_type: Which kind of entity the ids refer to

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = CheckEntityIntegrationArgs(entity_type=entity_type, entity_ids=entity_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("akanea-wms.check_entity_integration", _args)
    return [EntityIntegrationStatus(**item) for item in data]


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _upsert_receptions_op(
    receptions: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a upsert_receptions Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpsertReceptionsArgs(receptions=receptions).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="akanea-wms.upsert_receptions", args=_args)

def upsert_receptions(
    receptions: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create or update inbound receptions

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    receptions: Receptions to send. Each needs `client_code_id`, `movement_code_id` and at least one line (`line_number`, `item_code`, `expected_sale_units`). Set `id` to update an existing one. Only documented fields are transmitted — see the reception payload in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upsert_receptions_op(
        receptions=receptions,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upsert_receptions failed"))
    return result[0].get("data", {})

upsert_receptions.op = _upsert_receptions_op


def _upsert_preparations_op(
    preparations: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a upsert_preparations Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpsertPreparationsArgs(preparations=preparations).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="akanea-wms.upsert_preparations", args=_args)

def upsert_preparations(
    preparations: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create or update outbound preparation orders

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    preparations: Preparations to send. Each needs `client_code_id`, `consignee_code_id` and at least one line (`line_number`, `item_code`, `ordered_sale_units`). Set `id` to update an existing one. Only documented fields are transmitted — see the preparation payload in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upsert_preparations_op(
        preparations=preparations,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upsert_preparations failed"))
    return result[0].get("data", {})

upsert_preparations.op = _upsert_preparations_op


def _upsert_items_op(
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a upsert_items Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpsertItemsArgs(items=items).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="akanea-wms.upsert_items", args=_args)

def upsert_items(
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create or update item master records

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    items: Items to send. Each needs `client_code_id`, `item_code`, `description` and at least one `priority_racks` entry (`warehouse_id`, `movement_type`). Only documented fields are transmitted — see the item payload in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upsert_items_op(
        items=items,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upsert_items failed"))
    return result[0].get("data", {})

upsert_items.op = _upsert_items_op


def _upsert_parties_op(
    parties: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a upsert_parties Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpsertPartiesArgs(parties=parties).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="akanea-wms.upsert_parties", args=_args)

def upsert_parties(
    parties: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create or update third parties

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    parties: Parties to send. Each needs `id` (the party code); `party_category` picks F supplier, D consignee, S warehouse customer, T carrier. Only documented fields are transmitted — see the party payload in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upsert_parties_op(
        parties=parties,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upsert_parties failed"))
    return result[0].get("data", {})

upsert_parties.op = _upsert_parties_op


def _change_stock_op(
    stock_changes: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a change_stock Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ChangeStockArgs(stock_changes=stock_changes).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="akanea-wms.change_stock", args=_args)

def change_stock(
    stock_changes: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Correct stock objects (status, location, batch, dates)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    stock_changes: Stock objects to modify, identified by `client_code_id` plus `pallet_number` and/or `item_code`. The reception holding the stock must already be validated. Only documented fields are transmitted — see the stock payload in the guidance below.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _change_stock_op(
        stock_changes=stock_changes,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "change_stock failed"))
    return result[0].get("data", {})

change_stock.op = _change_stock_op
