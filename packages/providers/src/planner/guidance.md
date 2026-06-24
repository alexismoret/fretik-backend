## Patterns

### Find a plan's tasks

For "my tasks" / "what's on my plate", call `list_my_tasks` — it returns every
task assigned to the user across all plans, each with its `plan_id`, `etag`,
and `percent_complete`.

To browse a team's work, you need the plan's `group_id`. A Microsoft Teams
team id IS its Microsoft 365 group id — get one from `teams.list_joined_teams`,
then `list_group_plans(group_id=...)` → `list_plan_tasks(plan_id=...)`.

```python
from fretik_apps import teams, planner
team = teams.list_joined_teams()[0]
for plan in planner.list_group_plans(group_id=team.id):
    for task in planner.list_plan_tasks(plan_id=plan.id):
        print(task.title, task.percent_complete, task.due_date)
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
