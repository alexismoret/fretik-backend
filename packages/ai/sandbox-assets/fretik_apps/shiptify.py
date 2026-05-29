# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Shiptify provider — 54 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


# ── Types ─────────────────────────────────────────────────────────

class ShipmentRequest(BaseModel):
    id: int
    name: str
    status: str
    internal_ref: str | None = None
    shipment_mode_id: int | None = None
    reply_before: str | None = None
    total_weight: float | None = None
    total_volume: float | None = None
    total_linear_meters: float | None = None
    comment: str | None = None
    created_at: str | None = None


class Shipment(BaseModel):
    id: int
    status: str
    code: str | None = None
    tracking_code: str | None = None
    name: str | None = None
    internal_ref: str | None = None
    shipper_id: int | None = None
    carrier_id: int | None = None
    sh_request_id: int | None = None
    total_weight: float | None = None
    total_volume: float | None = None
    total_linear_meters: float | None = None
    estimated_departure_time: str | None = None
    real_departure_time: str | None = None
    estimated_arrival_time: str | None = None
    real_arrival_time: str | None = None
    shipment_mode: str | None = None
    shiptify_private_link: str | None = None
    shiptify_public_link: str | None = None


class TrackingPoint(BaseModel):
    id: int
    shipment_id: int | None = None
    type: str | None = None
    position: int | None = None
    address_id: int | None = None
    planned_date: str | None = None
    planned_time: str | None = None
    real_date: str | None = None
    real_time: str | None = None
    incident: str | None = None
    comment: str | None = None


class Attachment(BaseModel):
    id: int
    name: str
    type: str | None = None
    status: str | None = None


class Location(BaseModel):
    id: int
    name: str
    internal_ref: str | None = None
    recipient_name: str | None = None
    address_1: str | None = None
    address_2: str | None = None
    city: str | None = None
    state: str | None = None
    zipcode: str | None = None
    country: str | None = None
    type: str | None = None


class Carrier(BaseModel):
    id: int
    name: str
    code: str | None = None
    scac: str | None = None
    internal_ref: str | None = None


class ShipmentMode(BaseModel):
    id: int
    name: str


class ContentType(BaseModel):
    id: int
    name: str
    length: float | None = None
    width: float | None = None
    height: float | None = None
    weight: float | None = None
    dimension_unit: str | None = None
    weight_unit: str | None = None
    is_container: bool | None = None
    iso_container_type: str | None = None
    for_road: bool | None = None
    for_sea: bool | None = None
    for_air: bool | None = None
    for_rail: bool | None = None


class WriteResult(BaseModel):
    id: int | None = None
    internal_ref: str | None = None
    successful: bool | None = None


class AttachmentDownload(BaseModel):
    url: str


class GalaxyShipment(BaseModel):
    id: int
    code: str | None = None
    status: str | None = None
    tracking_code: str | None = None
    name: str | None = None
    internal_ref: str | None = None
    other_reference: str | None = None
    shipper_id: int | None = None
    carrier_id: int | None = None
    sh_request_id: int | None = None
    quote_request_id: int | None = None
    weight: str | None = None
    cost: str | None = None
    goods_value: str | None = None
    date: str | None = None
    in_out: str | None = None
    co2_amount: float | None = None
    archived_carrier: bool | None = None
    shipment_mode: str | None = None


class GalaxyShipmentRequest(BaseModel):
    id: int
    name: str | None = None
    status: str | None = None
    internal_ref: str | None = None
    other_reference: str | None = None
    shipper_id: int | None = None
    shipper_internal_ref: str | None = None
    shipment_mode: str | None = None
    shipment_mode_id: int | None = None
    reply_before: str | None = None
    total_weight: float | None = None
    total_volume: float | None = None
    total_linear_meters: float | None = None
    pre_awarded: bool | None = None
    comment: str | None = None
    created_at: str | None = None


class GalaxyPriceQuote(BaseModel):
    id: int
    price_detail_id: int | None = None
    price: float | None = None


class GalaxyShipper(BaseModel):
    id: int
    name: str
    account_id: int | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListShipmentRequestsArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0


class GetShipmentRequestArgs(BaseModel):
    id: int


class ListShipmentRequestAttachmentsArgs(BaseModel):
    id: int


class ListShipmentRequestShipmentsArgs(BaseModel):
    id: int


class CreateShipmentRequestArgs(BaseModel):
    name: str
    shipment_mode_id: int
    reply_before: str
    from_addresses: list[dict[str, Any]]
    dest_addresses: list[dict[str, Any]]
    accounting_entity_id: int | None = None
    carrier_id: int | None = None
    carrier_ids: list[int] | None = None
    comment: str | None = None
    internal_note: str | None = None
    internal_ref: str | None = None
    internal_name: str | None = None
    total_volume: float | None = None
    total_weight: float | None = None
    total_linear_meters: float | None = None
    measurement_system: Literal["metric", "imperial"] | None = None
    contents: list[dict[str, Any]] | None = None


class CreateShipmentRequestDraftArgs(BaseModel):
    name: str
    shipment_mode_id: int | None = None
    reply_before: str | None = None
    from_addresses: list[dict[str, Any]] | None = None
    dest_addresses: list[dict[str, Any]] | None = None
    comment: str | None = None
    internal_ref: str | None = None
    internal_name: str | None = None
    total_volume: float | None = None
    total_weight: float | None = None
    contents: list[dict[str, Any]] | None = None


class UpdateShipmentRequestArgs(BaseModel):
    id: int
    name: str | None = None
    accounting_entity_id: int | None = None
    comment: str | None = None
    internal_note: str | None = None
    internal_ref: str | None = None
    internal_name: str | None = None
    total_volume: float | None = None
    total_weight: float | None = None
    total_linear_meters: float | None = None
    measurement_system: Literal["metric", "imperial"] | None = None


class CancelShipmentRequestArgs(BaseModel):
    id: int


class UploadShipmentRequestAttachmentArgs(BaseModel):
    id: int
    attachments: list[dict[str, Any]]
    carrier_id: int | None = None


class SendShipmentRequestMessageArgs(BaseModel):
    id: int
    message: str
    carrier_id: int | None = None
    sender_name: str | None = None
    sender_email: str | None = None


class ListShipmentsArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0
    created_date_from: str | None = None
    created_date_to: str | None = None
    departure_date_min: str | None = None
    departure_date_max: str | None = None
    arrival_date_min: str | None = None
    arrival_date_max: str | None = None
    sh_request_id: int | None = None
    sr_internal_ref: str | None = None
    from_address_id: int | None = None
    dest_address_id: int | None = None
    from_address_internal_ref: str | None = None
    dest_address_internal_ref: str | None = None
    shipper_id: int | None = None


class GetShipmentArgs(BaseModel):
    id: int


class ListTrackingPointsArgs(BaseModel):
    id: int


class ListShipmentAttachmentsArgs(BaseModel):
    id: int


class GetAttachmentDownloadUrlArgs(BaseModel):
    id: int


class ConfirmShipmentPickupArgs(BaseModel):
    id: int
    date: str
    time: str | None = None
    comment: str | None = None
    incident: str | None = None
    cause_id: int | None = None


class ConfirmShipmentDeliveryArgs(BaseModel):
    id: int
    date: str
    time: str | None = None
    comment: str | None = None
    incident: str | None = None
    cause_id: int | None = None


class ReplanShipmentPickupArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    reason: str | None = None


class ReplanShipmentDeliveryArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    reason: str | None = None


class UploadShipmentAttachmentArgs(BaseModel):
    id: int
    attachments: list[dict[str, Any]]


class SendShipmentMessageArgs(BaseModel):
    id: int
    message: str
    sender_name: str | None = None
    sender_email: str | None = None


class ListLocationsArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0
    q: str | None = None
    internal_ref: str | None = None


class CreateLocationArgs(BaseModel):
    name: str
    address_1: str
    city: str
    zipcode: str
    country: str
    type: Literal["store", "final_customer", "warehouse", "factory", "port", "airport", "head_office", "other"] | None = None
    address_2: str | None = None
    state: str | None = None
    recipient_name: str | None = None
    company_name: str | None = None
    email: str | None = None
    phone_number: str | None = None
    instructions: str | None = None
    internal_ref: str | None = None
    locode: str | None = None
    contact: dict[str, Any] | None = None


class ListCarriersArgs(BaseModel):
    internal_ref: str | None = None


class ListShipmentModesArgs(BaseModel):
    pass


class ListContentTypesArgs(BaseModel):
    pass


class GalaxyListCarrierShipmentRequestsArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0


class GalaxyListReadyToBookArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0


class GalaxyListShipmentRequestAttachmentsArgs(BaseModel):
    id: int


class GalaxyCreateCarrierShipmentRequestArgs(BaseModel):
    name: str
    shipment_mode_id: int
    reply_before: str
    from_addresses: list[dict[str, Any]]
    dest_addresses: list[dict[str, Any]]
    shipper_id: int | None = None
    shipper_internal_ref: str | None = None
    other_reference: str | None = None
    accounting_entity_id: int | None = None
    comment: str | None = None
    internal_ref: str | None = None
    carrier_ids: list[int] | None = None
    pre_awarded: bool | None = None
    total_weight: float | None = None
    total_volume: float | None = None
    total_linear_meters: float | None = None
    measurement_system: Literal["metric", "imperial"] | None = None
    contents: list[dict[str, Any]] | None = None


class GalaxyCreateCarrierShipmentRequestDraftArgs(BaseModel):
    name: str
    shipment_mode_id: int | None = None
    reply_before: str | None = None
    shipper_id: int | None = None
    from_addresses: list[dict[str, Any]] | None = None
    dest_addresses: list[dict[str, Any]] | None = None
    comment: str | None = None
    internal_ref: str | None = None
    other_reference: str | None = None
    total_weight: float | None = None
    total_volume: float | None = None
    contents: list[dict[str, Any]] | None = None


class GalaxyUploadShipmentRequestAttachmentArgs(BaseModel):
    id: int
    attachments: list[dict[str, Any]]


class GalaxySendShipmentRequestMessageArgs(BaseModel):
    id: int
    message: str
    sender_name: str | None = None
    sender_email: str | None = None


class GalaxyListQuotePricesArgs(BaseModel):
    id: int


class GalaxyGetQuotePriceArgs(BaseModel):
    id: int
    priceId: int


class GalaxyCancelQuoteRequestArgs(BaseModel):
    id: int


class GalaxyListShipmentsArgs(BaseModel):
    limit: int | None = 25
    offset: int | None = 0


class GalaxyGetShipmentArgs(BaseModel):
    id: int


class GalaxyListTrackingPointsArgs(BaseModel):
    id: int


class GalaxyListShipmentAttachmentsArgs(BaseModel):
    id: int


class GalaxyConfirmShipmentPickupArgs(BaseModel):
    id: int
    date: str
    time: str | None = None
    comment: str | None = None
    incident: str | None = None


class GalaxyConfirmShipmentDeliveryArgs(BaseModel):
    id: int
    date: str
    time: str | None = None
    comment: str | None = None
    incident: str | None = None


class GalaxyReplanShipmentPickupArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    reason: str | None = None


class GalaxyReplanShipmentDeliveryArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    reason: str | None = None


class GalaxyConfirmShipmentArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None


class GalaxyCancelShipmentArgs(BaseModel):
    id: int
    comment: str | None = None


class GalaxyUploadShipmentAttachmentArgs(BaseModel):
    id: int
    attachments: list[dict[str, Any]]


class GalaxySendShipmentMessageArgs(BaseModel):
    id: int
    message: str
    sender_name: str | None = None
    sender_email: str | None = None


class GalaxyConfirmTrackingPointArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    incident: str | None = None


class GalaxyReplanTrackingPointArgs(BaseModel):
    id: int
    date: str | None = None
    time: str | None = None
    comment: str | None = None
    reason: str | None = None


class GalaxyCancelTrackingPointArgs(BaseModel):
    id: int
    comment: str | None = None


class GalaxyUpdateTrackingPointLocationArgs(BaseModel):
    id: int
    address_id: int
    tracking_point_id: int | None = None


class GalaxyListShippersArgs(BaseModel):
    pass


class GalaxyGetAttachmentDownloadUrlArgs(BaseModel):
    id: int


# ── Read actions (eager — execute immediately) ─────────

def list_shipment_requests(
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[ShipmentRequest]:
    """List shipment requests on the account

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentRequestsArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipment_requests", _args)
    return [ShipmentRequest(**item) for item in data]


def get_shipment_request(
    id: int,
    connection_id: str | None = None,
) -> ShipmentRequest:
    """Fetch one shipment request by id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetShipmentRequestArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.get_shipment_request", _args)
    return ShipmentRequest(**data)


def list_shipment_request_attachments(
    id: int,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a shipment request

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentRequestAttachmentsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipment_request_attachments", _args)
    return [Attachment(**item) for item in data]


def list_shipment_request_shipments(
    id: int,
    connection_id: str | None = None,
) -> list[Shipment]:
    """List the shipments produced by a shipment request

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentRequestShipmentsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipment_request_shipments", _args)
    return [Shipment(**item) for item in data]


def list_shipments(
    limit: int | None = 25,
    offset: int | None = 0,
    created_date_from: str | None = None,
    created_date_to: str | None = None,
    departure_date_min: str | None = None,
    departure_date_max: str | None = None,
    arrival_date_min: str | None = None,
    arrival_date_max: str | None = None,
    sh_request_id: int | None = None,
    sr_internal_ref: str | None = None,
    from_address_id: int | None = None,
    dest_address_id: int | None = None,
    from_address_internal_ref: str | None = None,
    dest_address_internal_ref: str | None = None,
    shipper_id: int | None = None,
    connection_id: str | None = None,
) -> list[Shipment]:
    """List shipments — the main tracking hub

    created_date_from: Filter by creation date (YYYY-MM-DD)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentsArgs(limit=limit, offset=offset, created_date_from=created_date_from, created_date_to=created_date_to, departure_date_min=departure_date_min, departure_date_max=departure_date_max, arrival_date_min=arrival_date_min, arrival_date_max=arrival_date_max, sh_request_id=sh_request_id, sr_internal_ref=sr_internal_ref, from_address_id=from_address_id, dest_address_id=dest_address_id, from_address_internal_ref=from_address_internal_ref, dest_address_internal_ref=dest_address_internal_ref, shipper_id=shipper_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipments", _args)
    return [Shipment(**item) for item in data]


def get_shipment(
    id: int,
    connection_id: str | None = None,
) -> Shipment:
    """Fetch one shipment by id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetShipmentArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.get_shipment", _args)
    return Shipment(**data)


def list_tracking_points(
    id: int,
    connection_id: str | None = None,
) -> list[TrackingPoint]:
    """List the tracking points (stops / events) of a shipment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListTrackingPointsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_tracking_points", _args)
    return [TrackingPoint(**item) for item in data]


def list_shipment_attachments(
    id: int,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a shipment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentAttachmentsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipment_attachments", _args)
    return [Attachment(**item) for item in data]


def get_attachment_download_url(
    id: int,
    connection_id: str | None = None,
) -> AttachmentDownload:
    """Get a signed URL to download one attachment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetAttachmentDownloadUrlArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.get_attachment_download_url", _args)
    return AttachmentDownload(**data)


def list_locations(
    limit: int | None = 25,
    offset: int | None = 0,
    q: str | None = None,
    internal_ref: str | None = None,
    connection_id: str | None = None,
) -> list[Location]:
    """List address-book locations — call before creating a SR to pick from/dest address ids

    q: Free-text search across name / address / city / zipcode / internal_ref

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListLocationsArgs(limit=limit, offset=offset, q=q, internal_ref=internal_ref).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_locations", _args)
    return [Location(**item) for item in data]


def list_carriers(
    internal_ref: str | None = None,
    connection_id: str | None = None,
) -> list[Carrier]:
    """List active carriers on the account

    internal_ref: Exact match on third-party reference

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListCarriersArgs(internal_ref=internal_ref).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_carriers", _args)
    return [Carrier(**item) for item in data]


def list_shipment_modes(
    connection_id: str | None = None,
) -> list[ShipmentMode]:
    """List shipment modes (road / sea / air / …) — call before create_shipment_request

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListShipmentModesArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_shipment_modes", _args)
    return [ShipmentMode(**item) for item in data]


def list_content_types(
    connection_id: str | None = None,
) -> list[ContentType]:
    """List active cargo content types — call before any create_shipment_request* to resolve `type_id` on each cargo line

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListContentTypesArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.list_content_types", _args)
    return [ContentType(**item) for item in data]


def galaxy_list_carrier_shipment_requests(
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[GalaxyShipmentRequest]:
    """List shipment requests received as a carrier (the quote inbox)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListCarrierShipmentRequestsArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_carrier_shipment_requests", _args)
    return [GalaxyShipmentRequest(**item) for item in data]


def galaxy_list_ready_to_book(
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[GalaxyShipmentRequest]:
    """List awarded shipment requests waiting for the carrier to book them

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListReadyToBookArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_ready_to_book", _args)
    return [GalaxyShipmentRequest(**item) for item in data]


def galaxy_list_shipment_request_attachments(
    id: int,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a carrier-side shipment request

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListShipmentRequestAttachmentsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_shipment_request_attachments", _args)
    return [Attachment(**item) for item in data]


def galaxy_list_quote_prices(
    id: int,
    connection_id: str | None = None,
) -> list[GalaxyPriceQuote]:
    """List the price lines proposed on a carrier-side quote

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListQuotePricesArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_quote_prices", _args)
    return [GalaxyPriceQuote(**item) for item in data]


def galaxy_get_quote_price(
    id: int,
    priceId: int,
    connection_id: str | None = None,
) -> GalaxyPriceQuote:
    """Fetch one price line on a carrier-side quote

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyGetQuotePriceArgs(id=id, priceId=priceId).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_get_quote_price", _args)
    return GalaxyPriceQuote(**data)


def galaxy_list_shipments(
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[GalaxyShipment]:
    """List shipments from the carrier's perspective — main tracking hub

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListShipmentsArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_shipments", _args)
    return [GalaxyShipment(**item) for item in data]


def galaxy_get_shipment(
    id: int,
    connection_id: str | None = None,
) -> GalaxyShipment:
    """Fetch one carrier-side shipment by id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyGetShipmentArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_get_shipment", _args)
    return GalaxyShipment(**data)


def galaxy_list_tracking_points(
    id: int,
    connection_id: str | None = None,
) -> list[TrackingPoint]:
    """List the tracking points (stops / events) of a carrier-side shipment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListTrackingPointsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_tracking_points", _args)
    return [TrackingPoint(**item) for item in data]


def galaxy_list_shipment_attachments(
    id: int,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a carrier-side shipment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListShipmentAttachmentsArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_shipment_attachments", _args)
    return [Attachment(**item) for item in data]


def galaxy_list_shippers(
    connection_id: str | None = None,
) -> list[GalaxyShipper]:
    """List active shippers a carrier works with — carrier counterpart of list_carriers

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyListShippersArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_list_shippers", _args)
    return [GalaxyShipper(**item) for item in data]


def galaxy_get_attachment_download_url(
    id: int,
    connection_id: str | None = None,
) -> AttachmentDownload:
    """Get a signed URL to download one attachment on a carrier-side shipment

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GalaxyGetAttachmentDownloadUrlArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("shiptify.galaxy_get_attachment_download_url", _args)
    return AttachmentDownload(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _create_shipment_request_op(
    name: str,
    shipment_mode_id: int,
    reply_before: str,
    from_addresses: list[dict[str, Any]],
    dest_addresses: list[dict[str, Any]],
    accounting_entity_id: int | None = None,
    carrier_id: int | None = None,
    carrier_ids: list[int] | None = None,
    comment: str | None = None,
    internal_note: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_shipment_request Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateShipmentRequestArgs(name=name, shipment_mode_id=shipment_mode_id, reply_before=reply_before, from_addresses=from_addresses, dest_addresses=dest_addresses, accounting_entity_id=accounting_entity_id, carrier_id=carrier_id, carrier_ids=carrier_ids, comment=comment, internal_note=internal_note, internal_ref=internal_ref, internal_name=internal_name, total_volume=total_volume, total_weight=total_weight, total_linear_meters=total_linear_meters, measurement_system=measurement_system, contents=contents).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.create_shipment_request", args=_args)

def create_shipment_request(
    name: str,
    shipment_mode_id: int,
    reply_before: str,
    from_addresses: list[dict[str, Any]],
    dest_addresses: list[dict[str, Any]],
    accounting_entity_id: int | None = None,
    carrier_id: int | None = None,
    carrier_ids: list[int] | None = None,
    comment: str | None = None,
    internal_note: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new shipment request (booking)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    name: Free-text booking name shown in lists

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_shipment_request_op(
        name=name,
        shipment_mode_id=shipment_mode_id,
        reply_before=reply_before,
        from_addresses=from_addresses,
        dest_addresses=dest_addresses,
        accounting_entity_id=accounting_entity_id,
        carrier_id=carrier_id,
        carrier_ids=carrier_ids,
        comment=comment,
        internal_note=internal_note,
        internal_ref=internal_ref,
        internal_name=internal_name,
        total_volume=total_volume,
        total_weight=total_weight,
        total_linear_meters=total_linear_meters,
        measurement_system=measurement_system,
        contents=contents,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_shipment_request failed"))
    return result[0].get("data", {})

create_shipment_request.op = _create_shipment_request_op


def _create_shipment_request_draft_op(
    name: str,
    shipment_mode_id: int | None = None,
    reply_before: str | None = None,
    from_addresses: list[dict[str, Any]] | None = None,
    dest_addresses: list[dict[str, Any]] | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_shipment_request_draft Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateShipmentRequestDraftArgs(name=name, shipment_mode_id=shipment_mode_id, reply_before=reply_before, from_addresses=from_addresses, dest_addresses=dest_addresses, comment=comment, internal_ref=internal_ref, internal_name=internal_name, total_volume=total_volume, total_weight=total_weight, contents=contents).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.create_shipment_request_draft", args=_args)

def create_shipment_request_draft(
    name: str,
    shipment_mode_id: int | None = None,
    reply_before: str | None = None,
    from_addresses: list[dict[str, Any]] | None = None,
    dest_addresses: list[dict[str, Any]] | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a draft shipment request (status: draft)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    reply_before: Format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_shipment_request_draft_op(
        name=name,
        shipment_mode_id=shipment_mode_id,
        reply_before=reply_before,
        from_addresses=from_addresses,
        dest_addresses=dest_addresses,
        comment=comment,
        internal_ref=internal_ref,
        internal_name=internal_name,
        total_volume=total_volume,
        total_weight=total_weight,
        contents=contents,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_shipment_request_draft failed"))
    return result[0].get("data", {})

create_shipment_request_draft.op = _create_shipment_request_draft_op


def _update_shipment_request_op(
    id: int,
    name: str | None = None,
    accounting_entity_id: int | None = None,
    comment: str | None = None,
    internal_note: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_shipment_request Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateShipmentRequestArgs(id=id, name=name, accounting_entity_id=accounting_entity_id, comment=comment, internal_note=internal_note, internal_ref=internal_ref, internal_name=internal_name, total_volume=total_volume, total_weight=total_weight, total_linear_meters=total_linear_meters, measurement_system=measurement_system).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.update_shipment_request", args=_args)

def update_shipment_request(
    id: int,
    name: str | None = None,
    accounting_entity_id: int | None = None,
    comment: str | None = None,
    internal_note: str | None = None,
    internal_ref: str | None = None,
    internal_name: str | None = None,
    total_volume: float | None = None,
    total_weight: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update fields of a shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_shipment_request_op(
        id=id,
        name=name,
        accounting_entity_id=accounting_entity_id,
        comment=comment,
        internal_note=internal_note,
        internal_ref=internal_ref,
        internal_name=internal_name,
        total_volume=total_volume,
        total_weight=total_weight,
        total_linear_meters=total_linear_meters,
        measurement_system=measurement_system,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_shipment_request failed"))
    return result[0].get("data", {})

update_shipment_request.op = _update_shipment_request_op


def _cancel_shipment_request_op(
    id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a cancel_shipment_request Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CancelShipmentRequestArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.cancel_shipment_request", args=_args)

def cancel_shipment_request(
    id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel a shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _cancel_shipment_request_op(
        id=id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "cancel_shipment_request failed"))
    return result[0].get("data", {})

cancel_shipment_request.op = _cancel_shipment_request_op


def _upload_shipment_request_attachment_op(
    id: int,
    attachments: list[dict[str, Any]],
    carrier_id: int | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a upload_shipment_request_attachment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UploadShipmentRequestAttachmentArgs(id=id, attachments=attachments, carrier_id=carrier_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.upload_shipment_request_attachment", args=_args)

def upload_shipment_request_attachment(
    id: int,
    attachments: list[dict[str, Any]],
    carrier_id: int | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Upload one or several files onto a shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    attachments: Files to upload — each item `{ fileName, documentType, base64Data | url, accessType?, save? }`. `documentType` is one of: invoice, order, customs, packing_list, bill_of_lading, cmr, cmr_at_departure, signed_cmr_at_arrival, proof_of_delivery, awb, msds, claim, other (full list in Shiptify docs).

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upload_shipment_request_attachment_op(
        id=id,
        attachments=attachments,
        carrier_id=carrier_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upload_shipment_request_attachment failed"))
    return result[0].get("data", {})

upload_shipment_request_attachment.op = _upload_shipment_request_attachment_op


def _send_shipment_request_message_op(
    id: int,
    message: str,
    carrier_id: int | None = None,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_shipment_request_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendShipmentRequestMessageArgs(id=id, message=message, carrier_id=carrier_id, sender_name=sender_name, sender_email=sender_email).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.send_shipment_request_message", args=_args)

def send_shipment_request_message(
    id: int,
    message: str,
    carrier_id: int | None = None,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a message in the booking chat of a shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    message: Plain-text message body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _send_shipment_request_message_op(
        id=id,
        message=message,
        carrier_id=carrier_id,
        sender_name=sender_name,
        sender_email=sender_email,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "send_shipment_request_message failed"))
    return result[0].get("data", {})

send_shipment_request_message.op = _send_shipment_request_message_op


def _confirm_shipment_pickup_op(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    cause_id: int | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a confirm_shipment_pickup Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ConfirmShipmentPickupArgs(id=id, date=date, time=time, comment=comment, incident=incident, cause_id=cause_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.confirm_shipment_pickup", args=_args)

def confirm_shipment_pickup(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    cause_id: int | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm pickup of a shipment (creates the actual pickup point)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: Pickup date — YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _confirm_shipment_pickup_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        incident=incident,
        cause_id=cause_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "confirm_shipment_pickup failed"))
    return result[0].get("data", {})

confirm_shipment_pickup.op = _confirm_shipment_pickup_op


def _confirm_shipment_delivery_op(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    cause_id: int | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a confirm_shipment_delivery Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ConfirmShipmentDeliveryArgs(id=id, date=date, time=time, comment=comment, incident=incident, cause_id=cause_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.confirm_shipment_delivery", args=_args)

def confirm_shipment_delivery(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    cause_id: int | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm delivery of a shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: Delivery date — YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _confirm_shipment_delivery_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        incident=incident,
        cause_id=cause_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "confirm_shipment_delivery failed"))
    return result[0].get("data", {})

confirm_shipment_delivery.op = _confirm_shipment_delivery_op


def _replan_shipment_pickup_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a replan_shipment_pickup Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplanShipmentPickupArgs(id=id, date=date, time=time, comment=comment, reason=reason).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.replan_shipment_pickup", args=_args)

def replan_shipment_pickup(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replan pickup of a shipment (new date / time)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: New pickup date — YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _replan_shipment_pickup_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        reason=reason,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "replan_shipment_pickup failed"))
    return result[0].get("data", {})

replan_shipment_pickup.op = _replan_shipment_pickup_op


def _replan_shipment_delivery_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a replan_shipment_delivery Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplanShipmentDeliveryArgs(id=id, date=date, time=time, comment=comment, reason=reason).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.replan_shipment_delivery", args=_args)

def replan_shipment_delivery(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replan delivery of a shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _replan_shipment_delivery_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        reason=reason,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "replan_shipment_delivery failed"))
    return result[0].get("data", {})

replan_shipment_delivery.op = _replan_shipment_delivery_op


def _upload_shipment_attachment_op(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a upload_shipment_attachment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UploadShipmentAttachmentArgs(id=id, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.upload_shipment_attachment", args=_args)

def upload_shipment_attachment(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Upload one or several files onto a shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    attachments: Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`. `documentType` examples: proof_of_delivery, cmr, signed_cmr_at_arrival, invoice, awb, customs, claim, other.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _upload_shipment_attachment_op(
        id=id,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "upload_shipment_attachment failed"))
    return result[0].get("data", {})

upload_shipment_attachment.op = _upload_shipment_attachment_op


def _send_shipment_message_op(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_shipment_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendShipmentMessageArgs(id=id, message=message, sender_name=sender_name, sender_email=sender_email).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.send_shipment_message", args=_args)

def send_shipment_message(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a message in the tracking chat of a shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    message: Plain-text message body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _send_shipment_message_op(
        id=id,
        message=message,
        sender_name=sender_name,
        sender_email=sender_email,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "send_shipment_message failed"))
    return result[0].get("data", {})

send_shipment_message.op = _send_shipment_message_op


def _create_location_op(
    name: str,
    address_1: str,
    city: str,
    zipcode: str,
    country: str,
    type: Literal["store", "final_customer", "warehouse", "factory", "port", "airport", "head_office", "other"] | None = None,
    address_2: str | None = None,
    state: str | None = None,
    recipient_name: str | None = None,
    company_name: str | None = None,
    email: str | None = None,
    phone_number: str | None = None,
    instructions: str | None = None,
    internal_ref: str | None = None,
    locode: str | None = None,
    contact: dict[str, Any] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_location Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateLocationArgs(name=name, address_1=address_1, city=city, zipcode=zipcode, country=country, type=type, address_2=address_2, state=state, recipient_name=recipient_name, company_name=company_name, email=email, phone_number=phone_number, instructions=instructions, internal_ref=internal_ref, locode=locode, contact=contact).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.create_location", args=_args)

def create_location(
    name: str,
    address_1: str,
    city: str,
    zipcode: str,
    country: str,
    type: Literal["store", "final_customer", "warehouse", "factory", "port", "airport", "head_office", "other"] | None = None,
    address_2: str | None = None,
    state: str | None = None,
    recipient_name: str | None = None,
    company_name: str | None = None,
    email: str | None = None,
    phone_number: str | None = None,
    instructions: str | None = None,
    internal_ref: str | None = None,
    locode: str | None = None,
    contact: dict[str, Any] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new address-book location — use ONLY when list_locations returned no match

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    name: Short label shown in the Shiptify address book

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_location_op(
        name=name,
        address_1=address_1,
        city=city,
        zipcode=zipcode,
        country=country,
        type=type,
        address_2=address_2,
        state=state,
        recipient_name=recipient_name,
        company_name=company_name,
        email=email,
        phone_number=phone_number,
        instructions=instructions,
        internal_ref=internal_ref,
        locode=locode,
        contact=contact,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_location failed"))
    return result[0].get("data", {})

create_location.op = _create_location_op


def _galaxy_create_carrier_shipment_request_op(
    name: str,
    shipment_mode_id: int,
    reply_before: str,
    from_addresses: list[dict[str, Any]],
    dest_addresses: list[dict[str, Any]],
    shipper_id: int | None = None,
    shipper_internal_ref: str | None = None,
    other_reference: str | None = None,
    accounting_entity_id: int | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    carrier_ids: list[int] | None = None,
    pre_awarded: bool | None = None,
    total_weight: float | None = None,
    total_volume: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_create_carrier_shipment_request Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyCreateCarrierShipmentRequestArgs(name=name, shipment_mode_id=shipment_mode_id, reply_before=reply_before, from_addresses=from_addresses, dest_addresses=dest_addresses, shipper_id=shipper_id, shipper_internal_ref=shipper_internal_ref, other_reference=other_reference, accounting_entity_id=accounting_entity_id, comment=comment, internal_ref=internal_ref, carrier_ids=carrier_ids, pre_awarded=pre_awarded, total_weight=total_weight, total_volume=total_volume, total_linear_meters=total_linear_meters, measurement_system=measurement_system, contents=contents).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_create_carrier_shipment_request", args=_args)

def galaxy_create_carrier_shipment_request(
    name: str,
    shipment_mode_id: int,
    reply_before: str,
    from_addresses: list[dict[str, Any]],
    dest_addresses: list[dict[str, Any]],
    shipper_id: int | None = None,
    shipper_internal_ref: str | None = None,
    other_reference: str | None = None,
    accounting_entity_id: int | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    carrier_ids: list[int] | None = None,
    pre_awarded: bool | None = None,
    total_weight: float | None = None,
    total_volume: float | None = None,
    total_linear_meters: float | None = None,
    measurement_system: Literal["metric", "imperial"] | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a carrier-initiated shipment request (spot booking)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    shipment_mode_id: Mode id from list_shipment_modes()

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_create_carrier_shipment_request_op(
        name=name,
        shipment_mode_id=shipment_mode_id,
        reply_before=reply_before,
        from_addresses=from_addresses,
        dest_addresses=dest_addresses,
        shipper_id=shipper_id,
        shipper_internal_ref=shipper_internal_ref,
        other_reference=other_reference,
        accounting_entity_id=accounting_entity_id,
        comment=comment,
        internal_ref=internal_ref,
        carrier_ids=carrier_ids,
        pre_awarded=pre_awarded,
        total_weight=total_weight,
        total_volume=total_volume,
        total_linear_meters=total_linear_meters,
        measurement_system=measurement_system,
        contents=contents,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_create_carrier_shipment_request failed"))
    return result[0].get("data", {})

galaxy_create_carrier_shipment_request.op = _galaxy_create_carrier_shipment_request_op


def _galaxy_create_carrier_shipment_request_draft_op(
    name: str,
    shipment_mode_id: int | None = None,
    reply_before: str | None = None,
    shipper_id: int | None = None,
    from_addresses: list[dict[str, Any]] | None = None,
    dest_addresses: list[dict[str, Any]] | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    other_reference: str | None = None,
    total_weight: float | None = None,
    total_volume: float | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_create_carrier_shipment_request_draft Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyCreateCarrierShipmentRequestDraftArgs(name=name, shipment_mode_id=shipment_mode_id, reply_before=reply_before, shipper_id=shipper_id, from_addresses=from_addresses, dest_addresses=dest_addresses, comment=comment, internal_ref=internal_ref, other_reference=other_reference, total_weight=total_weight, total_volume=total_volume, contents=contents).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_create_carrier_shipment_request_draft", args=_args)

def galaxy_create_carrier_shipment_request_draft(
    name: str,
    shipment_mode_id: int | None = None,
    reply_before: str | None = None,
    shipper_id: int | None = None,
    from_addresses: list[dict[str, Any]] | None = None,
    dest_addresses: list[dict[str, Any]] | None = None,
    comment: str | None = None,
    internal_ref: str | None = None,
    other_reference: str | None = None,
    total_weight: float | None = None,
    total_volume: float | None = None,
    contents: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a draft carrier-side shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    reply_before: Format YYYY-MM-DDTHH:MM:SS (NO timezone suffix). Example: '2026-06-10T18:00:00'.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_create_carrier_shipment_request_draft_op(
        name=name,
        shipment_mode_id=shipment_mode_id,
        reply_before=reply_before,
        shipper_id=shipper_id,
        from_addresses=from_addresses,
        dest_addresses=dest_addresses,
        comment=comment,
        internal_ref=internal_ref,
        other_reference=other_reference,
        total_weight=total_weight,
        total_volume=total_volume,
        contents=contents,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_create_carrier_shipment_request_draft failed"))
    return result[0].get("data", {})

galaxy_create_carrier_shipment_request_draft.op = _galaxy_create_carrier_shipment_request_draft_op


def _galaxy_upload_shipment_request_attachment_op(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_upload_shipment_request_attachment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyUploadShipmentRequestAttachmentArgs(id=id, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_upload_shipment_request_attachment", args=_args)

def galaxy_upload_shipment_request_attachment(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Upload one or several files onto a carrier-side shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    attachments: Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`. Same documentType enum as the shipper version.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_upload_shipment_request_attachment_op(
        id=id,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_upload_shipment_request_attachment failed"))
    return result[0].get("data", {})

galaxy_upload_shipment_request_attachment.op = _galaxy_upload_shipment_request_attachment_op


def _galaxy_send_shipment_request_message_op(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_send_shipment_request_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxySendShipmentRequestMessageArgs(id=id, message=message, sender_name=sender_name, sender_email=sender_email).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_send_shipment_request_message", args=_args)

def galaxy_send_shipment_request_message(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a message in the booking chat of a carrier-side shipment request

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    message: Plain-text message body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_send_shipment_request_message_op(
        id=id,
        message=message,
        sender_name=sender_name,
        sender_email=sender_email,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_send_shipment_request_message failed"))
    return result[0].get("data", {})

galaxy_send_shipment_request_message.op = _galaxy_send_shipment_request_message_op


def _galaxy_cancel_quote_request_op(
    id: int,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_cancel_quote_request Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyCancelQuoteRequestArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_cancel_quote_request", args=_args)

def galaxy_cancel_quote_request(
    id: int,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel a quote request the carrier received

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_cancel_quote_request_op(
        id=id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_cancel_quote_request failed"))
    return result[0].get("data", {})

galaxy_cancel_quote_request.op = _galaxy_cancel_quote_request_op


def _galaxy_confirm_shipment_pickup_op(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_confirm_shipment_pickup Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyConfirmShipmentPickupArgs(id=id, date=date, time=time, comment=comment, incident=incident).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_confirm_shipment_pickup", args=_args)

def galaxy_confirm_shipment_pickup(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm pickup of a carrier-side shipment (creates the actual pickup point)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: Pickup date — YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_confirm_shipment_pickup_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        incident=incident,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_confirm_shipment_pickup failed"))
    return result[0].get("data", {})

galaxy_confirm_shipment_pickup.op = _galaxy_confirm_shipment_pickup_op


def _galaxy_confirm_shipment_delivery_op(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_confirm_shipment_delivery Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyConfirmShipmentDeliveryArgs(id=id, date=date, time=time, comment=comment, incident=incident).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_confirm_shipment_delivery", args=_args)

def galaxy_confirm_shipment_delivery(
    id: int,
    date: str,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm delivery of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: Delivery date — YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_confirm_shipment_delivery_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        incident=incident,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_confirm_shipment_delivery failed"))
    return result[0].get("data", {})

galaxy_confirm_shipment_delivery.op = _galaxy_confirm_shipment_delivery_op


def _galaxy_replan_shipment_pickup_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_replan_shipment_pickup Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyReplanShipmentPickupArgs(id=id, date=date, time=time, comment=comment, reason=reason).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_replan_shipment_pickup", args=_args)

def galaxy_replan_shipment_pickup(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replan pickup of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_replan_shipment_pickup_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        reason=reason,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_replan_shipment_pickup failed"))
    return result[0].get("data", {})

galaxy_replan_shipment_pickup.op = _galaxy_replan_shipment_pickup_op


def _galaxy_replan_shipment_delivery_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_replan_shipment_delivery Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyReplanShipmentDeliveryArgs(id=id, date=date, time=time, comment=comment, reason=reason).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_replan_shipment_delivery", args=_args)

def galaxy_replan_shipment_delivery(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replan delivery of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_replan_shipment_delivery_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        reason=reason,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_replan_shipment_delivery failed"))
    return result[0].get("data", {})

galaxy_replan_shipment_delivery.op = _galaxy_replan_shipment_delivery_op


def _galaxy_confirm_shipment_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_confirm_shipment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyConfirmShipmentArgs(id=id, date=date, time=time).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_confirm_shipment", args=_args)

def galaxy_confirm_shipment(
    id: int,
    date: str | None = None,
    time: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm the whole shipment (distinct from per-leg pickup / delivery)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_confirm_shipment_op(
        id=id,
        date=date,
        time=time,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_confirm_shipment failed"))
    return result[0].get("data", {})

galaxy_confirm_shipment.op = _galaxy_confirm_shipment_op


def _galaxy_cancel_shipment_op(
    id: int,
    comment: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_cancel_shipment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyCancelShipmentArgs(id=id, comment=comment).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_cancel_shipment", args=_args)

def galaxy_cancel_shipment(
    id: int,
    comment: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_cancel_shipment_op(
        id=id,
        comment=comment,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_cancel_shipment failed"))
    return result[0].get("data", {})

galaxy_cancel_shipment.op = _galaxy_cancel_shipment_op


def _galaxy_upload_shipment_attachment_op(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_upload_shipment_attachment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyUploadShipmentAttachmentArgs(id=id, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_upload_shipment_attachment", args=_args)

def galaxy_upload_shipment_attachment(
    id: int,
    attachments: list[dict[str, Any]],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Upload one or several files onto a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    attachments: Files — each `{ fileName, documentType, base64Data | url, accessType?, save? }`

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_upload_shipment_attachment_op(
        id=id,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_upload_shipment_attachment failed"))
    return result[0].get("data", {})

galaxy_upload_shipment_attachment.op = _galaxy_upload_shipment_attachment_op


def _galaxy_send_shipment_message_op(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_send_shipment_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxySendShipmentMessageArgs(id=id, message=message, sender_name=sender_name, sender_email=sender_email).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_send_shipment_message", args=_args)

def galaxy_send_shipment_message(
    id: int,
    message: str,
    sender_name: str | None = None,
    sender_email: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a message in the tracking chat of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    message: Plain-text message body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_send_shipment_message_op(
        id=id,
        message=message,
        sender_name=sender_name,
        sender_email=sender_email,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_send_shipment_message failed"))
    return result[0].get("data", {})

galaxy_send_shipment_message.op = _galaxy_send_shipment_message_op


def _galaxy_confirm_tracking_point_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_confirm_tracking_point Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyConfirmTrackingPointArgs(id=id, date=date, time=time, comment=comment, incident=incident).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_confirm_tracking_point", args=_args)

def galaxy_confirm_tracking_point(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    incident: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Confirm a single tracking point (transit stop, customs, …) of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_confirm_tracking_point_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        incident=incident,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_confirm_tracking_point failed"))
    return result[0].get("data", {})

galaxy_confirm_tracking_point.op = _galaxy_confirm_tracking_point_op


def _galaxy_replan_tracking_point_op(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_replan_tracking_point Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyReplanTrackingPointArgs(id=id, date=date, time=time, comment=comment, reason=reason).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_replan_tracking_point", args=_args)

def galaxy_replan_tracking_point(
    id: int,
    date: str | None = None,
    time: str | None = None,
    comment: str | None = None,
    reason: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Replan a single tracking point of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    date: YYYY-MM-DD

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_replan_tracking_point_op(
        id=id,
        date=date,
        time=time,
        comment=comment,
        reason=reason,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_replan_tracking_point failed"))
    return result[0].get("data", {})

galaxy_replan_tracking_point.op = _galaxy_replan_tracking_point_op


def _galaxy_cancel_tracking_point_op(
    id: int,
    comment: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_cancel_tracking_point Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyCancelTrackingPointArgs(id=id, comment=comment).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_cancel_tracking_point", args=_args)

def galaxy_cancel_tracking_point(
    id: int,
    comment: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel a single tracking point of a carrier-side shipment

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_cancel_tracking_point_op(
        id=id,
        comment=comment,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_cancel_tracking_point failed"))
    return result[0].get("data", {})

galaxy_cancel_tracking_point.op = _galaxy_cancel_tracking_point_op


def _galaxy_update_tracking_point_location_op(
    id: int,
    address_id: int,
    tracking_point_id: int | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a galaxy_update_tracking_point_location Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GalaxyUpdateTrackingPointLocationArgs(id=id, address_id=address_id, tracking_point_id=tracking_point_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="shiptify.galaxy_update_tracking_point_location", args=_args)

def galaxy_update_tracking_point_location(
    id: int,
    address_id: int,
    tracking_point_id: int | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a tracking point of a carrier-side shipment to a different address

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    address_id: Target address id from list_locations()

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _galaxy_update_tracking_point_location_op(
        id=id,
        address_id=address_id,
        tracking_point_id=tracking_point_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "galaxy_update_tracking_point_location failed"))
    return result[0].get("data", {})

galaxy_update_tracking_point_location.op = _galaxy_update_tracking_point_location_op
