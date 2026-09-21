## What this app is

A fixed set of orders, invoices and customers, served from memory. It is a test
double used by the eval suites — there is no account behind it and nothing here
ever changes.

Three orders (`EV-1001`, `EV-1002`, `EV-1003`), three invoices keyed on those
orders' references, and four customers (`CL-001` … `CL-003`, plus `CL-999`,
which no order points at).

## Patterns

### Read the orders

`list_orders` is paginated by `limit` / `offset`, and bounded by
`updated_after` when you only want what changed.

```python
from fretik_apps import eval_fixture

page = eval_fixture.list_orders(limit=2)
for order in page:
    print(order.reference, order.amount, order.status)

changed = eval_fixture.list_orders(updated_after="2026-09-19T00:00:00Z")
```

### One record, or the whole list

Both exist for the same entity, and they are not interchangeable:
`list_orders` costs one call per page, `get_order` one call per record. Reach
for the list whenever you want more than a handful.

```python
one = eval_fixture.get_order(id="ord_1001")
```

### Joining the two apps

`list_invoices` carries `order_reference`, which is the same value as an
order's `reference`. That is how a second connection fills a payment column on
records the first one created.

```python
invoices = eval_fixture.list_invoices()
by_order = {inv.order_reference: inv.payment_status for inv in invoices}
```
