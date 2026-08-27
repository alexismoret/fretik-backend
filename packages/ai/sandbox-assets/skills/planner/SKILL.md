---
name: planner
description: Microsoft Planner — read tasks and plans; create, update, and delete tasks; manage buckets and plans
version: a08519bffbd4
---

# Microsoft Planner — 14 actions

You can interact with the user's Microsoft Planner account via the `fretik_apps.planner` Python module.

## Read actions (auto-approved, eager)

- `planner.list_my_tasks()` — List ONLY the tasks assigned to the signed-in user, across all plans
- `planner.list_group_plans(group_id)` — List the plans owned by a Microsoft 365 group (= a Teams team)
- `planner.get_plan(plan_id)` — Fetch one plan by ID (title, owning group, etag)
- `planner.list_plan_buckets(plan_id)` — List the buckets (columns) of a plan
- `planner.list_plan_labels(plan_id)` — List a plan's label definitions (maps PlannerTask.label_ids to names)
- `planner.list_plan_tasks(plan_id)` — List ALL tasks in a plan, every bucket (auto-paginated — returns the full set, not a page)
- `planner.list_bucket_tasks(bucket_id)` — List ALL tasks in one bucket (auto-paginated — use this to scope to a single column)
- `planner.get_task_details(task_id)` — Fetch a task's description, checklist and reference links

## Write actions (require user approval — build with `.op()`)

- `planner.create_task.op(plan_id, title, bucket_id=None, assignee_ids=None, due_date=None, start_date=None, percent_complete=None, priority=None)` — Create a task in a plan (optionally in a bucket, with assignees)
- `planner.update_task.op(task_id, etag, title=None, bucket_id=None, due_date=None, start_date=None, percent_complete=None, priority=None, assignee_ids=None)` — Update a task — title, bucket, dates, %complete, assignees
- `planner.update_task_details.op(task_id, etag, description=None, checklist=None)` — Set a task's description and/or replace its checklist
- `planner.delete_task.op(task_id, etag)` — Delete a task
- `planner.create_bucket.op(plan_id, name)` — Create a bucket (column) in a plan
- `planner.create_plan.op(group_id, title)` — Create a plan owned by a Microsoft 365 group

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `PlannerTask` — `id: str`, `etag: str`, `title: str`, `plan_id: str`, `bucket_id?: str`, `percent_complete: int`, `priority?: int`, `due_date?: str`, `start_date?: str`, `completed_at?: str`, `assignee_ids?: list[str]`, `label_ids?: list[str]`, `has_description: bool`, `created_at: str`
- `PlannerLabel` — `id: str`, `name: str`
- `PlannerTaskDetails` — `id: str`, `etag: str`, `description?: str`, `checklist: list[dict]`, `references: list[dict]`
- `PlannerPlan` — `id: str`, `etag: str`, `title: str`, `group_id?: str`, `created_at: str`
- `PlannerBucket` — `id: str`, `etag: str`, `name: str`, `plan_id: str`, `order_hint?: str`
- `WriteResult` — `id?: str`, `etag?: str`

## Patterns

### Pick the right list action

- `list_my_tasks` — ONLY tasks assigned to the signed-in user. Use it for
  "my tasks" / "what's on my plate". It does NOT return a plan's or a team's
  full task set — for that, use the plan/bucket actions below.
- `list_plan_tasks(plan_id)` — every task in a plan, across all buckets.
- `list_bucket_tasks(bucket_id)` — every task in ONE bucket (a board column).

All three return the **complete** set — they auto-paginate Planner's ~400/page
limit server-side. `len(tasks)` is the real total; never assume the first
slice is everything.

### Find a plan's (or a bucket's) tasks

To browse a team's work you need the plan's `group_id`. A Microsoft Teams team
id IS its Microsoft 365 group id — get one from `teams.list_joined_teams`,
then `list_group_plans(group_id=...)`.

```python
from fretik_apps import teams, planner
team = teams.list_joined_teams()[0]                       # team.id == group_id
for plan in planner.list_group_plans(group_id=team.id):
    tasks = planner.list_plan_tasks(plan_id=plan.id)      # ALL tasks, all pages
    print(plan.title, len(tasks))
```

For a specific board column, resolve the bucket then scope to it directly —
cheaper and clearer than pulling the whole plan and filtering:

```python
buckets = planner.list_plan_buckets(plan_id=plan_id)
bucket = next(b for b in buckets if b.name == "Systèmes & Réseaux")
tasks = planner.list_bucket_tasks(bucket_id=bucket.id)    # all tasks in that column
```

### Searching & filtering — always in Python, never server-side

The Planner API supports NO query filtering: `$filter`, `$search`, `$orderby`
are accepted but **silently ignored** (you get every task back, unfiltered).
There is also no text-search endpoint. So the recipe is always the same:
**narrow structurally first** (a bucket, a plan, or `list_my_tasks`), then
filter the returned list in Python.

```python
tasks = planner.list_plan_tasks(plan_id=plan_id)   # full set

# text — case-insensitive "contains" (the ILIKE %x% equivalent)
hits = [t for t in tasks if "gpo" in t.title.lower()]

# status — 0 not started / 50 in progress / 100 done
open_tasks = [t for t in tasks if t.percent_complete < 100]

# assignee
mine = [t for t in tasks if "USER-AAD-ID" in (t.assignee_ids or [])]
```

Dates are **full ISO-8601 UTC** (`2026-04-30T10:00:00Z`), NOT date-only —
`date.fromisoformat(t.due_date)` raises. Parse the datetime, then compare:

```python
from datetime import datetime, timezone
def due(t):
    return datetime.fromisoformat(t.due_date.replace("Z", "+00:00")) if t.due_date else None

now = datetime.now(timezone.utc)
overdue = [t for t in tasks if t.percent_complete < 100 and (d := due(t)) and d < now]
```

Filter by label/category — `t.label_ids` holds IDs like `category1`; resolve
names once with `list_plan_labels`:

```python
labels = {l.id: l.name for l in planner.list_plan_labels(plan_id=plan_id)}
urgent = [t for t in tasks if any(labels.get(i) == "Urgent" for i in (t.label_ids or []))]
```

### Update or delete a task — the etag rule

Every task and plan carries an `etag`. `update_task`, `update_task_details`,
and `delete_task` REQUIRE the current `etag` (sent as `If-Match`). Read the
task in one turn to capture its `etag`, then submit the write in the next turn
with that literal `etag`:

```python
from fretik_apps import planner, run_plan
tasks = planner.list_my_tasks()           # turn 1 — read, capture etag
t = tasks[0]
run_plan([                                 # turn 2 — write with the etag
    planner.update_task.op(task_id=t.id, etag=t.etag, percent_complete=100),
])
```

A stale `etag` fails with HTTP 412. When that happens, re-read the task to get
a fresh `etag` and resubmit — never guess the value.

### Progress is 0 / 50 / 100

`percent_complete` maps to Planner's three states: `0` not started, `50` in
progress, `100` completed. Use these exact values.

### Description and checklist live on the details object

`title`, dates, bucket, assignees and `percent_complete` are on the task
(`update_task`). The `description` and `checklist` live on a separate details
object — read with `get_task_details`, write with `update_task_details` (its
own `etag`). `update_task_details` REPLACES the whole checklist; send every
item you want to keep.

### Assignees are Azure AD user IDs

`assignee_ids` take Azure AD user IDs, not emails. Resolve a name with
`teams.find_user` first, then pass the matched `user_id`.

### Creating a plan needs group membership

`create_plan(group_id=..., title=...)` only succeeds when the signed-in user
is a member of that Microsoft 365 group.

### Multiple connected Planner accounts

When several Planner connections exist, the system prompt's `<external_apps>`
block handles disambiguation. Pass the chosen `connection_id` explicitly:

```python
run_plan([planner.create_task.op(
    connection_id="3f1a…-contoso",
    plan_id="xqQg…", title="Draft Q3 report",
)])
```

Calling a write without `connection_id` while several Planner accounts are
connected raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION` — recover per the upstream
rule.

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write: `run_plan([ planner.create_task.op(plan_id="…", title="…") ])`
- Many writes: `run_plan([ planner.<action>.op(...), ... ])`

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
