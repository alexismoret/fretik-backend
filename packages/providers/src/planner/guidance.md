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
planner.create_task(
    connection_id="3f1a…-contoso",
    plan_id="xqQg…", title="Draft Q3 report",
)
```

Calling a write without `connection_id` while several Planner accounts are
connected raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION` — recover per the upstream
rule.
