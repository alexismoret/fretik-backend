# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Eval Fixture provider — 5 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class Order(BaseModel):
    id: str
    reference: str
    amount: float
    status: Literal["draft", "confirmed", "cancelled"]
    client_code: str
    updated_at: str


class Invoice(BaseModel):
    id: str
    order_reference: str
    payment_status: Literal["pending", "paid", "overdue"]
    due_date: str


class Customer(BaseModel):
    id: str
    code: str
    name: str
    email: str
    phone: str


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListOrdersArgs(BaseModel):
    limit: int | None = 50
    offset: int | None = 0
    updated_after: str | None = None


class GetOrderArgs(BaseModel):
    id: str


class ListInvoicesArgs(BaseModel):
    limit: int | None = 50
    offset: int | None = 0


class ListCustomersArgs(BaseModel):
    limit: int | None = 50
    offset: int | None = 0


class GetCustomerArgs(BaseModel):
    id: str


# ── Read actions (eager — execute immediately) ─────────

def list_orders(
    limit: int | None = 50,
    offset: int | None = 0,
    updated_after: str | None = None,
    connection_id: str | None = None,
) -> list[Order]:
    """List orders, newest first

    updated_after: Only orders changed at or after this instant

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListOrdersArgs(limit=limit, offset=offset, updated_after=updated_after).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("eval-fixture.list_orders", _args)
    return [Order(**item) for item in data]


def get_order(
    id: str,
    connection_id: str | None = None,
) -> Order:
    """Fetch one order by id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetOrderArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("eval-fixture.get_order", _args)
    return Order(**data)


def list_invoices(
    limit: int | None = 50,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Invoice]:
    """List invoices, each carrying the reference of the order it bills

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListInvoicesArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("eval-fixture.list_invoices", _args)
    return [Invoice(**item) for item in data]


def list_customers(
    limit: int | None = 50,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Customer]:
    """List customers

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListCustomersArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("eval-fixture.list_customers", _args)
    return [Customer(**item) for item in data]


def get_customer(
    id: str,
    connection_id: str | None = None,
) -> Customer:
    """Fetch one customer by id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetCustomerArgs(id=id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("eval-fixture.get_customer", _args)
    return Customer(**data)
