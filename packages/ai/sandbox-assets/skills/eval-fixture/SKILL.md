---
name: eval-fixture
description: Eval Fixture — a test double that serves a fixed set of orders, invoices and customers from memory. Not a real app: it exists so the eval suites can read an app that answers.
version: 9e9ea30665a0
---

# Eval Fixture — 5 actions

You can interact with the user's Eval Fixture account via the `fretik_apps.eval_fixture` Python module.

## Read actions (auto-approved, eager)

- `eval_fixture.list_orders(limit=50, offset=0, updated_after=None)` — List orders, newest first
- `eval_fixture.get_order(id)` — Fetch one order by id
- `eval_fixture.list_invoices(limit=50, offset=0)` — List invoices, each carrying the reference of the order it bills
- `eval_fixture.list_customers(limit=50, offset=0)` — List customers
- `eval_fixture.get_customer(id)` — Fetch one customer by id

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Order` — `id: str`, `reference: str`, `amount: float`, `status: Literal["draft", "confirmed", "cancelled"]`, `client_code: str`, `updated_at: str`
- `Invoice` — `id: str`, `order_reference: str`, `payment_status: Literal["pending", "paid", "overdue"]`, `due_date: str`
- `Customer` — `id: str`, `code: str`, `name: str`, `email: str`, `phone: str`


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

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write:   `run_plan([ eval_fixture.list_orders.op() ])`
- Many writes: `run_plan([ eval_fixture.<action>.op(...), ... ])`

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
