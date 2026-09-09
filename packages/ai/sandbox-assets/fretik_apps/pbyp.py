# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Pbyp provider — 37 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class Me(BaseModel):
    user_id: str
    email: str
    name: str
    current_entities: list[int]
    profile_id: int | None = None
    profile_role: str | None = None
    entity_id: int | None = None
    entity_name: str | None = None
    is_client: bool | None = None


class Profile(BaseModel):
    id: int
    entity_id: int
    entity_name: str
    role: str | None = None
    is_client: bool | None = None


class FieldDoc(BaseModel):
    collection: str
    field: str
    type: str
    required: bool | None = None
    computed: bool | None = None
    links_to: str | None = None
    path: str | None = None
    choices: list[str] | None = None
    note: str | None = None


class StoredFile(BaseModel):
    id: str
    filename_download: str
    type: str
    filesize: int


class Event(BaseModel):
    id: int
    code: str
    type_id: int
    date: str
    actual: bool
    source: str
    label: str | None = None
    terminal: str | None = None
    address: str | None = None
    comments: str | None = None


class EventType(BaseModel):
    id: int
    code: str
    modules: list[str]
    category: list[str]
    label: str | None = None


class Gateway(BaseModel):
    id: int
    external_code: str
    gateway_type: int
    gateway_label: str | None = None
    entity_id: int | None = None
    status: str | None = None


class StatusCount(BaseModel):
    shipping_status: str
    count: int


class Counter(BaseModel):
    counter: str
    month_key: str
    pattern: str


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class DescribeCollectionArgs(BaseModel):
    collections: list[str]


class QueryItemsArgs(BaseModel):
    collection: str
    filter: dict[str, Any] | None = None
    fields: list[str] | None = None
    include_archived: bool | None = False
    sort: list[str] | None = None
    limit: int | None = 25
    page: int | None = 1
    search: str | None = None
    deep: dict[str, Any] | None = None
    aggregate: dict[str, Any] | None = None
    group_by: list[str] | None = None


class CreateItemsArgs(BaseModel):
    collection: str
    items: list[dict[str, Any]]


class UpdateItemsArgs(BaseModel):
    collection: str
    ids: list[int]
    data: dict[str, Any]


class DeleteItemsArgs(BaseModel):
    collection: str
    ids: list[int]


class UploadFileArgs(BaseModel):
    filename: str
    content_base64: str
    content_type: str | None = None


class WhoamiArgs(BaseModel):
    pass


class ListProfilesArgs(BaseModel):
    pass


class ListEventsArgs(BaseModel):
    target_type: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container"]
    target_id: int
    limit: int | None = 25


class ListEventTypesArgs(BaseModel):
    module: Literal["sea", "air"] | None = None
    category: Literal["booking", "container", "folder", "order"] | None = None


class ListGatewaysArgs(BaseModel):
    pass


class CountByStatusArgs(BaseModel):
    object: Literal["order", "folder", "booking", "container"]
    module: Literal["sea", "air"] | None = None
    date_from: str | None = None
    date_to: str | None = None


class NextOrderNumberArgs(BaseModel):
    module: Literal["sea", "air"]


class NextQuotationNumberArgs(BaseModel):
    pass


class CreateOrderArgs(BaseModel):
    module: Literal["sea", "air"]
    number: str
    date: str
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]
    entity_id: int
    shipper: dict[str, Any]
    consignee: dict[str, Any]
    client_reference: str | None = None
    billing_reference: str | None = None
    comments: str | None = None
    pickup_date: str | None = None
    delivery_date: str | None = None
    available_date: str | None = None
    deadline: str | None = None
    parcels: list[dict[str, Any]] | None = None
    parcels_description: str | None = None
    parcels_price: float | None = None
    parcels_price_currency: Literal["EUR", "USD"] | None = None
    folder_id: int | None = None
    shared_with: list[dict[str, Any]] | None = None


class CreateFolderArgs(BaseModel):
    module: Literal["sea", "air"]
    folder_type: Literal["single", "master", "house"]
    date: str
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]
    entity_id: int
    shipper: dict[str, Any]
    consignee: dict[str, Any]
    payer_id: int | None = None
    master_id: int | None = None
    voyage_id: int | None = None
    client_reference: str | None = None
    billing_reference: str | None = None
    comments: str | None = None
    pickup_date: str | None = None
    delivery_date: str | None = None
    order_ids: list[int] | None = None
    parcels: list[dict[str, Any]] | None = None
    shared_with: list[dict[str, Any]] | None = None


class CreateSeaBookingArgs(BaseModel):
    booking_number: str
    entity_id: int
    booking_type: Literal["import", "export"]
    departure_terminal: int
    arrival_terminal: int
    ETD: str
    ETA: str
    ship_name: str | None = None
    voyage_number: str | None = None
    BL_number: str | None = None
    agent_code: str | None = None
    company_id: int | None = None
    custom_company: str | None = None
    containers: list[dict[str, Any]] | None = None


class CreateAirBookingArgs(BaseModel):
    booking_number: str
    entity_id: int
    booking_type: Literal["import", "export"]
    LTA: str
    flights: list[dict[str, Any]]
    voyage_number: str | None = None
    agent_code: str | None = None
    airline_company: int | None = None
    custom_company: str | None = None


class CreateQuotationArgs(BaseModel):
    number: str
    entity_id: int
    transport_type: Literal["sea", "air"]
    booking_type: Literal["import", "export"]
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]
    margin: float
    counterparty: int
    shipper: dict[str, Any]
    consignee: dict[str, Any]
    departure_terminal: int
    arrival_terminal: int
    etd: str
    eta: str
    validity_start_date: str | None = None
    validity_end_date: str | None = None
    comments: str | None = None
    parcels: list[dict[str, Any]] | None = None
    quotes: list[dict[str, Any]] | None = None


class AddEventArgs(BaseModel):
    target_type: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container"]
    target_id: int
    event_type_id: int
    date: str
    actual: bool | None = None
    terminal_id: int | None = None
    address_id: int | None = None
    comments: str | None = None


class SetParcelsArgs(BaseModel):
    target_type: Literal["order", "sea_folder", "air_folder"]
    target_id: int
    parcels: list[dict[str, Any]]


class AttachOrderToFolderArgs(BaseModel):
    module: Literal["sea", "air"]
    order_id: int
    folder_id: int


class DetachOrderFromFolderArgs(BaseModel):
    module: Literal["sea", "air"]
    order_id: int
    folder_id: int


class ShareWithEntityArgs(BaseModel):
    object: Literal["order", "sea_folder", "air_folder"]
    object_id: int
    entity_id: int
    can_edit: bool | None = False


class RevokeShareArgs(BaseModel):
    object: Literal["order", "sea_folder", "air_folder"]
    object_id: int
    entity_id: int


class ArchiveArgs(BaseModel):
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container", "quotation"]
    object_id: int


class SetQuotationStatusArgs(BaseModel):
    quotation_id: int
    quotation_status: Literal["DRAFT", "TRANSFERRED_TO_CLIENT", "TRANSFERRED_TO_FREIGHT_FORWARDER", "ACCEPTED", "DECLINED", "CANCELED"]


class TransferToGatewayArgs(BaseModel):
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "event"]
    object_id: int
    gateway_id: int
    external_reference: str | None = None


class AssignContainersArgs(BaseModel):
    scope: Literal["order", "folder"]
    items: list[dict[str, Any]]


class UnassignParcelContainerArgs(BaseModel):
    scope: Literal["order", "folder"]
    target_id: int
    parcel_id: int


class ActivateProfileArgs(BaseModel):
    profile_id: int


class CreateGatewayArgs(BaseModel):
    gateway_type: int
    external_code: str
    entity_id: int


class UpdateGatewayArgs(BaseModel):
    gateway_id: int
    gateway_type: int
    external_code: str


class DeclareTrackingArgs(BaseModel):
    module: Literal["sea", "air"]
    booking_id: int


class CreateLtaStockArgs(BaseModel):
    first_awb: str
    last_awb: str
    airline_company: int
    entity_id: int


class InviteUserArgs(BaseModel):
    first_name: str
    last_name: str
    email: str
    role_id: int
    entity_id: int
    phone: str | None = None


class CreateClientArgs(BaseModel):
    agency_id: int
    name: str
    admin_user: dict[str, Any]
    commercial: dict[str, Any]
    address: dict[str, Any]


# ── Read actions (eager — execute immediately) ─────────

def describe_collection(
    collections: list[str],
    connection_id: str | None = None,
) -> list[FieldDoc]:
    """The shape of up to 5 collections at once. Returns ONE ROW PER COLUMN — a flat list across every collection asked for, each row carrying its own `collection` — with whether the column is required or computed, a dropdown's allowed values, and for a link the exact path to write in fields or filter.

    collections: Collection names, e.g. ["orders", "air_folders", "terminals"]. Ask for every table your question touches in ONE call.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DescribeCollectionArgs(collections=collections).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.describe_collection", _args)
    return [FieldDoc(**item) for item in data]


def query_items(
    collection: str,
    filter: dict[str, Any] | None = None,
    fields: list[str] | None = None,
    include_archived: bool | None = False,
    sort: list[str] | None = None,
    limit: int | None = 25,
    page: int | None = 1,
    search: str | None = None,
    deep: dict[str, Any] | None = None,
    aggregate: dict[str, Any] | None = None,
    group_by: list[str] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Read or count any collection: filter, nested field paths, sort, search, deep, aggregate. This is how you find things — there is no separate search action.

    filter: Directus filter, e.g. {"shipping_status": {"_eq": "IN_TRANSIT"}}. Operators: _eq _neq _in _nin _lt _lte _gt _gte _null _nnull _contains _icontains _starts_with _between _and _or.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = QueryItemsArgs(collection=collection, filter=filter, fields=fields, include_archived=include_archived, sort=sort, limit=limit, page=page, search=search, deep=deep, aggregate=aggregate, group_by=group_by).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return _call_read("pbyp.query_items", _args)


def upload_file(
    filename: str,
    content_base64: str,
    content_type: str | None = None,
    connection_id: str | None = None,
) -> StoredFile:
    """Store a file's bytes in Pbyp and return the id to link it with. It is attached to NOTHING on its own — see 'Filing a document' in the guidance for the create_items call that puts it in an order's or a folder's GED.

    filename: Name the document is shown and downloaded under, with its extension. No directories.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = UploadFileArgs(filename=filename, content_base64=content_base64, content_type=content_type).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.upload_file", _args)
    return StoredFile(**data)


def whoami(
    connection_id: str | None = None,
) -> Me:
    """Who this connection acts as: the active profile, its entity, whether it is a forwarder or a client, and the entity ids it can see.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = WhoamiArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.whoami", _args)
    return Me(**data)


def list_profiles(
    connection_id: str | None = None,
) -> list[Profile]:
    """The profiles this account holds. Only one is active at a time — activate_profile() switches.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListProfilesArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.list_profiles", _args)
    return [Profile(**item) for item in data]


def list_events(
    target_type: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container"],
    target_id: int,
    limit: int | None = 25,
    connection_id: str | None = None,
) -> list[Event]:
    """The event history of one object, most recent first — the milestones that drive its status.

    target_type: The object family the row hangs off.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListEventsArgs(target_type=target_type, target_id=target_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.list_events", _args)
    return [Event(**item) for item in data]


def list_event_types(
    module: Literal["sea", "air"] | None = None,
    category: Literal["booking", "container", "folder", "order"] | None = None,
    connection_id: str | None = None,
) -> list[EventType]:
    """The event catalogue: which milestone codes exist, for which module, and what they can be attached to.

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListEventTypesArgs(module=module, category=category).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.list_event_types", _args)
    return [EventType(**item) for item in data]


def list_gateways(
    connection_id: str | None = None,
) -> list[Gateway]:
    """EDI gateways this account can see — the partners an object can be transferred to (PTD, …).

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListGatewaysArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.list_gateways", _args)
    return [Gateway(**item) for item in data]


def count_by_status(
    object: Literal["order", "folder", "booking", "container"],
    module: Literal["sea", "air"] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    connection_id: str | None = None,
) -> list[StatusCount]:
    """How many objects sit in each shipping status over a date window — the answer to 'how many are in transit'.

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = CountByStatusArgs(object=object, module=module, date_from=date_from, date_to=date_to).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.count_by_status", _args)
    return [StatusCount(**item) for item in data]


def next_order_number(
    module: Literal["sea", "air"],
    connection_id: str | None = None,
) -> Counter:
    """This month's next order sequence. Assemble the number as <entity_id>O<month_key><counter>.

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = NextOrderNumberArgs(module=module).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.next_order_number", _args)
    return Counter(**data)


def next_quotation_number(
    connection_id: str | None = None,
) -> Counter:
    """This month's next quotation sequence. Assemble the number as Q<entity_id><month_key><counter>.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = NextQuotationNumberArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("pbyp.next_quotation_number", _args)
    return Counter(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _create_items_op(
    collection: str,
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a create_items Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateItemsArgs(collection=collection, items=items).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_items", args=_args)

def create_items(
    collection: str,
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create one or more rows in any writable collection. Computed columns are stripped and reported back.

    (WRITE — build it with `create_items.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    items: One object per row. Call describe_collection() first when unsure of the shape; many-to-many lists take junction rows, e.g. parcels: [{parcels_id: 41}].

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_items is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_items.op(...)])"
    )

create_items.op = _create_items_op


def _update_items_op(
    collection: str,
    ids: list[int],
    data: dict[str, Any],
    connection_id: str | None = None,
) -> Operation:
    """Build a update_items Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateItemsArgs(collection=collection, ids=ids, data=data).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.update_items", args=_args)

def update_items(
    collection: str,
    ids: list[int],
    data: dict[str, Any],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Apply the same change to one or more rows of a collection, by id.

    (WRITE — build it with `update_items.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    ids: Primary keys to update.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_items is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.update_items.op(...)])"
    )

update_items.op = _update_items_op


def _delete_items_op(
    collection: str,
    ids: list[int],
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_items Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteItemsArgs(collection=collection, ids=ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.delete_items", args=_args)

def delete_items(
    collection: str,
    ids: list[int],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Permanently delete rows. Refused on orders, folders, bookings, containers and quotations — cancel those with archive().

    (WRITE — build it with `delete_items.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_items is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.delete_items.op(...)])"
    )

delete_items.op = _delete_items_op


def _create_order_op(
    module: Literal["sea", "air"],
    number: str,
    date: str,
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    entity_id: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    client_reference: str | None = None,
    billing_reference: str | None = None,
    comments: str | None = None,
    pickup_date: str | None = None,
    delivery_date: str | None = None,
    available_date: str | None = None,
    deadline: str | None = None,
    parcels: list[dict[str, Any]] | None = None,
    parcels_description: str | None = None,
    parcels_price: float | None = None,
    parcels_price_currency: Literal["EUR", "USD"] | None = None,
    folder_id: int | None = None,
    shared_with: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_order Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateOrderArgs(module=module, number=number, date=date, incoterm=incoterm, entity_id=entity_id, shipper=shipper, consignee=consignee, client_reference=client_reference, billing_reference=billing_reference, comments=comments, pickup_date=pickup_date, delivery_date=delivery_date, available_date=available_date, deadline=deadline, parcels=parcels, parcels_description=parcels_description, parcels_price=parcels_price, parcels_price_currency=parcels_price_currency, folder_id=folder_id, shared_with=shared_with).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_order", args=_args)

def create_order(
    module: Literal["sea", "air"],
    number: str,
    date: str,
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    entity_id: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    client_reference: str | None = None,
    billing_reference: str | None = None,
    comments: str | None = None,
    pickup_date: str | None = None,
    delivery_date: str | None = None,
    available_date: str | None = None,
    deadline: str | None = None,
    parcels: list[dict[str, Any]] | None = None,
    parcels_description: str | None = None,
    parcels_price: float | None = None,
    parcels_price_currency: Literal["EUR", "USD"] | None = None,
    folder_id: int | None = None,
    shared_with: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create an order: parties, incoterm, dates and cargo lines in one call.

    (WRITE — build it with `create_order.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_order is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_order.op(...)])"
    )

create_order.op = _create_order_op


def _create_folder_op(
    module: Literal["sea", "air"],
    folder_type: Literal["single", "master", "house"],
    date: str,
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    entity_id: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    payer_id: int | None = None,
    master_id: int | None = None,
    voyage_id: int | None = None,
    client_reference: str | None = None,
    billing_reference: str | None = None,
    comments: str | None = None,
    pickup_date: str | None = None,
    delivery_date: str | None = None,
    order_ids: list[int] | None = None,
    parcels: list[dict[str, Any]] | None = None,
    shared_with: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_folder Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateFolderArgs(module=module, folder_type=folder_type, date=date, incoterm=incoterm, entity_id=entity_id, shipper=shipper, consignee=consignee, payer_id=payer_id, master_id=master_id, voyage_id=voyage_id, client_reference=client_reference, billing_reference=billing_reference, comments=comments, pickup_date=pickup_date, delivery_date=delivery_date, order_ids=order_ids, parcels=parcels, shared_with=shared_with).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_folder", args=_args)

def create_folder(
    module: Literal["sea", "air"],
    folder_type: Literal["single", "master", "house"],
    date: str,
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    entity_id: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    payer_id: int | None = None,
    master_id: int | None = None,
    voyage_id: int | None = None,
    client_reference: str | None = None,
    billing_reference: str | None = None,
    comments: str | None = None,
    pickup_date: str | None = None,
    delivery_date: str | None = None,
    order_ids: list[int] | None = None,
    parcels: list[dict[str, Any]] | None = None,
    shared_with: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a transport folder — the file for one shipment. The folder number is assigned by Pbyp.

    (WRITE — build it with `create_folder.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_folder is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_folder.op(...)])"
    )

create_folder.op = _create_folder_op


def _create_sea_booking_op(
    booking_number: str,
    entity_id: int,
    booking_type: Literal["import", "export"],
    departure_terminal: int,
    arrival_terminal: int,
    ETD: str,
    ETA: str,
    ship_name: str | None = None,
    voyage_number: str | None = None,
    BL_number: str | None = None,
    agent_code: str | None = None,
    company_id: int | None = None,
    custom_company: str | None = None,
    containers: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_sea_booking Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateSeaBookingArgs(booking_number=booking_number, entity_id=entity_id, booking_type=booking_type, departure_terminal=departure_terminal, arrival_terminal=arrival_terminal, ETD=ETD, ETA=ETA, ship_name=ship_name, voyage_number=voyage_number, BL_number=BL_number, agent_code=agent_code, company_id=company_id, custom_company=custom_company, containers=containers).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_sea_booking", args=_args)

def create_sea_booking(
    booking_number: str,
    entity_id: int,
    booking_type: Literal["import", "export"],
    departure_terminal: int,
    arrival_terminal: int,
    ETD: str,
    ETA: str,
    ship_name: str | None = None,
    voyage_number: str | None = None,
    BL_number: str | None = None,
    agent_code: str | None = None,
    company_id: int | None = None,
    custom_company: str | None = None,
    containers: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a sea voyage, optionally with its containers.

    (WRITE — build it with `create_sea_booking.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    booking_type: Direction of the voyage for this agency.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_sea_booking is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_sea_booking.op(...)])"
    )

create_sea_booking.op = _create_sea_booking_op


def _create_air_booking_op(
    booking_number: str,
    entity_id: int,
    booking_type: Literal["import", "export"],
    LTA: str,
    flights: list[dict[str, Any]],
    voyage_number: str | None = None,
    agent_code: str | None = None,
    airline_company: int | None = None,
    custom_company: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_air_booking Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateAirBookingArgs(booking_number=booking_number, entity_id=entity_id, booking_type=booking_type, LTA=LTA, flights=flights, voyage_number=voyage_number, agent_code=agent_code, airline_company=airline_company, custom_company=custom_company).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_air_booking", args=_args)

def create_air_booking(
    booking_number: str,
    entity_id: int,
    booking_type: Literal["import", "export"],
    LTA: str,
    flights: list[dict[str, Any]],
    voyage_number: str | None = None,
    agent_code: str | None = None,
    airline_company: int | None = None,
    custom_company: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create an air booking with its flight legs. ETD, ETA and the terminals are derived from the legs.

    (WRITE — build it with `create_air_booking.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    booking_type: Direction of the flight for this agency.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_air_booking is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_air_booking.op(...)])"
    )

create_air_booking.op = _create_air_booking_op


def _create_quotation_op(
    number: str,
    entity_id: int,
    transport_type: Literal["sea", "air"],
    booking_type: Literal["import", "export"],
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    margin: float,
    counterparty: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    departure_terminal: int,
    arrival_terminal: int,
    etd: str,
    eta: str,
    validity_start_date: str | None = None,
    validity_end_date: str | None = None,
    comments: str | None = None,
    parcels: list[dict[str, Any]] | None = None,
    quotes: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_quotation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateQuotationArgs(number=number, entity_id=entity_id, transport_type=transport_type, booking_type=booking_type, incoterm=incoterm, margin=margin, counterparty=counterparty, shipper=shipper, consignee=consignee, departure_terminal=departure_terminal, arrival_terminal=arrival_terminal, etd=etd, eta=eta, validity_start_date=validity_start_date, validity_end_date=validity_end_date, comments=comments, parcels=parcels, quotes=quotes).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_quotation", args=_args)

def create_quotation(
    number: str,
    entity_id: int,
    transport_type: Literal["sea", "air"],
    booking_type: Literal["import", "export"],
    incoterm: Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"],
    margin: float,
    counterparty: int,
    shipper: dict[str, Any],
    consignee: dict[str, Any],
    departure_terminal: int,
    arrival_terminal: int,
    etd: str,
    eta: str,
    validity_start_date: str | None = None,
    validity_end_date: str | None = None,
    comments: str | None = None,
    parcels: list[dict[str, Any]] | None = None,
    quotes: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a quotation with its purchase and sale lines.

    (WRITE — build it with `create_quotation.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    number: From next_quotation_number() — see its pattern.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_quotation is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_quotation.op(...)])"
    )

create_quotation.op = _create_quotation_op


def _add_event_op(
    target_type: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container"],
    target_id: int,
    event_type_id: int,
    date: str,
    actual: bool | None = None,
    terminal_id: int | None = None,
    address_id: int | None = None,
    comments: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a add_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AddEventArgs(target_type=target_type, target_id=target_id, event_type_id=event_type_id, date=date, actual=actual, terminal_id=terminal_id, address_id=address_id, comments=comments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.add_event", args=_args)

def add_event(
    target_type: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container"],
    target_id: int,
    event_type_id: int,
    date: str,
    actual: bool | None = None,
    terminal_id: int | None = None,
    address_id: int | None = None,
    comments: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Record a milestone on one object. Events drive shipping_status — this is how a shipment advances.

    (WRITE — build it with `add_event.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    target_type: The object family the row hangs off.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "add_event is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.add_event.op(...)])"
    )

add_event.op = _add_event_op


def _set_parcels_op(
    target_type: Literal["order", "sea_folder", "air_folder"],
    target_id: int,
    parcels: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a set_parcels Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SetParcelsArgs(target_type=target_type, target_id=target_id, parcels=parcels).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.set_parcels", args=_args)

def set_parcels(
    target_type: Literal["order", "sea_folder", "air_folder"],
    target_id: int,
    parcels: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replace the cargo lines of an order or a folder. The previous list is dropped.

    (WRITE — build it with `set_parcels.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "set_parcels is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.set_parcels.op(...)])"
    )

set_parcels.op = _set_parcels_op


def _attach_order_to_folder_op(
    module: Literal["sea", "air"],
    order_id: int,
    folder_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a attach_order_to_folder Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AttachOrderToFolderArgs(module=module, order_id=order_id, folder_id=folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.attach_order_to_folder", args=_args)

def attach_order_to_folder(
    module: Literal["sea", "air"],
    order_id: int,
    folder_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Link an order to a folder of the same module.

    (WRITE — build it with `attach_order_to_folder.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "attach_order_to_folder is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.attach_order_to_folder.op(...)])"
    )

attach_order_to_folder.op = _attach_order_to_folder_op


def _detach_order_from_folder_op(
    module: Literal["sea", "air"],
    order_id: int,
    folder_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a detach_order_from_folder Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DetachOrderFromFolderArgs(module=module, order_id=order_id, folder_id=folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.detach_order_from_folder", args=_args)

def detach_order_from_folder(
    module: Literal["sea", "air"],
    order_id: int,
    folder_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Unlink an order from a folder.

    (WRITE — build it with `detach_order_from_folder.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "detach_order_from_folder is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.detach_order_from_folder.op(...)])"
    )

detach_order_from_folder.op = _detach_order_from_folder_op


def _share_with_entity_op(
    object: Literal["order", "sea_folder", "air_folder"],
    object_id: int,
    entity_id: int,
    can_edit: bool | None = False,
    connection_id: str | None = None,
) -> Operation:
    """Build a share_with_entity Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ShareWithEntityArgs(object=object, object_id=object_id, entity_id=entity_id, can_edit=can_edit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.share_with_entity", args=_args)

def share_with_entity(
    object: Literal["order", "sea_folder", "air_folder"],
    object_id: int,
    entity_id: int,
    can_edit: bool | None = False,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Give another entity access to an order or a folder — it will see it in its own Pbyp.

    (WRITE — build it with `share_with_entity.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    object: Only orders and folders can be shared with another entity.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "share_with_entity is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.share_with_entity.op(...)])"
    )

share_with_entity.op = _share_with_entity_op


def _revoke_share_op(
    object: Literal["order", "sea_folder", "air_folder"],
    object_id: int,
    entity_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a revoke_share Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RevokeShareArgs(object=object, object_id=object_id, entity_id=entity_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.revoke_share", args=_args)

def revoke_share(
    object: Literal["order", "sea_folder", "air_folder"],
    object_id: int,
    entity_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Remove an entity's access to an order or a folder.

    (WRITE — build it with `revoke_share.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    object: Only orders and folders can be shared with another entity.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "revoke_share is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.revoke_share.op(...)])"
    )

revoke_share.op = _revoke_share_op


def _archive_op(
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container", "quotation"],
    object_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a archive Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ArchiveArgs(object=object, object_id=object_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.archive", args=_args)

def archive(
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "container", "quotation"],
    object_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel an object. Pbyp archives rather than deletes: the status becomes CANCELED and the cancellation cascades.

    (WRITE — build it with `archive.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    object: The object to cancel.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "archive is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.archive.op(...)])"
    )

archive.op = _archive_op


def _set_quotation_status_op(
    quotation_id: int,
    quotation_status: Literal["DRAFT", "TRANSFERRED_TO_CLIENT", "TRANSFERRED_TO_FREIGHT_FORWARDER", "ACCEPTED", "DECLINED", "CANCELED"],
    connection_id: str | None = None,
) -> Operation:
    """Build a set_quotation_status Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SetQuotationStatusArgs(quotation_id=quotation_id, quotation_status=quotation_status).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.set_quotation_status", args=_args)

def set_quotation_status(
    quotation_id: int,
    quotation_status: Literal["DRAFT", "TRANSFERRED_TO_CLIENT", "TRANSFERRED_TO_FREIGHT_FORWARDER", "ACCEPTED", "DECLINED", "CANCELED"],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a quotation through its workflow.

    (WRITE — build it with `set_quotation_status.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    quotation_status: A forwarder sends with TRANSFERRED_TO_CLIENT, a client asks with TRANSFERRED_TO_FREIGHT_FORWARDER; the receiving side then ACCEPTED or DECLINED. CANCELED is always allowed.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "set_quotation_status is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.set_quotation_status.op(...)])"
    )

set_quotation_status.op = _set_quotation_status_op


def _transfer_to_gateway_op(
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "event"],
    object_id: int,
    gateway_id: int,
    external_reference: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a transfer_to_gateway Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = TransferToGatewayArgs(object=object, object_id=object_id, gateway_id=gateway_id, external_reference=external_reference).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.transfer_to_gateway", args=_args)

def transfer_to_gateway(
    object: Literal["order", "sea_folder", "air_folder", "sea_booking", "air_booking", "event"],
    object_id: int,
    gateway_id: int,
    external_reference: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Enrol an object in an EDI gateway (PTD, …) so the partner picks it up on its next pull.

    (WRITE — build it with `transfer_to_gateway.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    gateway_id: From list_gateways().

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "transfer_to_gateway is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.transfer_to_gateway.op(...)])"
    )

transfer_to_gateway.op = _transfer_to_gateway_op


def _assign_containers_op(
    scope: Literal["order", "folder"],
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a assign_containers Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AssignContainersArgs(scope=scope, items=items).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.assign_containers", args=_args)

def assign_containers(
    scope: Literal["order", "folder"],
    items: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Stuff an order's or a folder's cargo into containers — fully, or line by line across several boxes.

    (WRITE — build it with `assign_containers.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "assign_containers is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.assign_containers.op(...)])"
    )

assign_containers.op = _assign_containers_op


def _unassign_parcel_container_op(
    scope: Literal["order", "folder"],
    target_id: int,
    parcel_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a unassign_parcel_container Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UnassignParcelContainerArgs(scope=scope, target_id=target_id, parcel_id=parcel_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.unassign_parcel_container", args=_args)

def unassign_parcel_container(
    scope: Literal["order", "folder"],
    target_id: int,
    parcel_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Take one cargo line back out of its container. The quantity returns to the unassigned line.

    (WRITE — build it with `unassign_parcel_container.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    target_id: Order or folder id.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "unassign_parcel_container is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.unassign_parcel_container.op(...)])"
    )

unassign_parcel_container.op = _unassign_parcel_container_op


def _activate_profile_op(
    profile_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a activate_profile Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ActivateProfileArgs(profile_id=profile_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.activate_profile", args=_args)

def activate_profile(
    profile_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Switch the active profile. This changes what this connection — and the user's own Pbyp session — can see.

    (WRITE — build it with `activate_profile.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "activate_profile is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.activate_profile.op(...)])"
    )

activate_profile.op = _activate_profile_op


def _create_gateway_op(
    gateway_type: int,
    external_code: str,
    entity_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_gateway Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateGatewayArgs(gateway_type=gateway_type, external_code=external_code, entity_id=entity_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_gateway", args=_args)

def create_gateway(
    gateway_type: int,
    external_code: str,
    entity_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create an EDI gateway for an entity — this also creates the partner's access account.

    (WRITE — build it with `create_gateway.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    gateway_type: Partner type id from `external_reference_types`.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_gateway is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_gateway.op(...)])"
    )

create_gateway.op = _create_gateway_op


def _update_gateway_op(
    gateway_id: int,
    gateway_type: int,
    external_code: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_gateway Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateGatewayArgs(gateway_id=gateway_id, gateway_type=gateway_type, external_code=external_code).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.update_gateway", args=_args)

def update_gateway(
    gateway_id: int,
    gateway_type: int,
    external_code: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Change an existing gateway's partner type or code.

    (WRITE — build it with `update_gateway.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_gateway is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.update_gateway.op(...)])"
    )

update_gateway.op = _update_gateway_op


def _declare_tracking_op(
    module: Literal["sea", "air"],
    booking_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a declare_tracking Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeclareTrackingArgs(module=module, booking_id=booking_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.declare_tracking", args=_args)

def declare_tracking(
    module: Literal["sea", "air"],
    booking_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Register a booking with the carrier tracking service, so events start arriving on their own.

    (WRITE — build it with `declare_tracking.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    module: Transport module. Pbyp keeps sea and air in separate tables — pick the one the user means, never guess from context alone.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "declare_tracking is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.declare_tracking.op(...)])"
    )

declare_tracking.op = _declare_tracking_op


def _create_lta_stock_op(
    first_awb: str,
    last_awb: str,
    airline_company: int,
    entity_id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_lta_stock Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateLtaStockArgs(first_awb=first_awb, last_awb=last_awb, airline_company=airline_company, entity_id=entity_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_lta_stock", args=_args)

def create_lta_stock(
    first_awb: str,
    last_awb: str,
    airline_company: int,
    entity_id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reserve a range of air waybill numbers for an entity and an airline.

    (WRITE — build it with `create_lta_stock.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    first_awb: First number of the range, 8 digits.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_lta_stock is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_lta_stock.op(...)])"
    )

create_lta_stock.op = _create_lta_stock_op


def _invite_user_op(
    first_name: str,
    last_name: str,
    email: str,
    role_id: int,
    entity_id: int,
    phone: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a invite_user Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = InviteUserArgs(first_name=first_name, last_name=last_name, email=email, role_id=role_id, entity_id=entity_id, phone=phone).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.invite_user", args=_args)

def invite_user(
    first_name: str,
    last_name: str,
    email: str,
    role_id: int,
    entity_id: int,
    phone: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Invite someone to an entity with a role. They receive an e-mail invitation.

    (WRITE — build it with `invite_user.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    role_id: From the `roles` collection.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "invite_user is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.invite_user.op(...)])"
    )

invite_user.op = _invite_user_op


def _create_client_op(
    agency_id: int,
    name: str,
    admin_user: dict[str, Any],
    commercial: dict[str, Any],
    address: dict[str, Any],
    connection_id: str | None = None,
) -> Operation:
    """Build a create_client Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateClientArgs(agency_id=agency_id, name=name, admin_user=admin_user, commercial=commercial, address=address).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="pbyp.create_client", args=_args)

def create_client(
    agency_id: int,
    name: str,
    admin_user: dict[str, Any],
    commercial: dict[str, Any],
    address: dict[str, Any],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a client company under an agency: the entity, its address book, its roles and its first admin account.

    (WRITE — build it with `create_client.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    agency_id: The agency this client belongs to.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_client is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([pbyp.create_client.op(...)])"
    )

create_client.op = _create_client_op
