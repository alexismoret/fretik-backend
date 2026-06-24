# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Microsoft Planner provider — 14 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


# ── Types ─────────────────────────────────────────────────────────

class PlannerTask(BaseModel):
    id: str
    etag: str
    title: str
    plan_id: str
    percent_complete: int
    has_description: bool
    created_at: str
    bucket_id: str | None = None
    priority: int | None = None
    due_date: str | None = None
    start_date: str | None = None
    completed_at: str | None = None
    assignee_ids: list[str] | None = None
    label_ids: list[str] | None = None


class PlannerLabel(BaseModel):
    id: str
    name: str


class PlannerTaskDetails(BaseModel):
    id: str
    etag: str
    checklist: list[dict[str, Any]]
    references: list[dict[str, Any]]
    description: str | None = None


class PlannerPlan(BaseModel):
    id: str
    etag: str
    title: str
    created_at: str
    group_id: str | None = None


class PlannerBucket(BaseModel):
    id: str
    etag: str
    name: str
    plan_id: str
    order_hint: str | None = None


class WriteResult(BaseModel):
    id: str | None = None
    etag: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListMyTasksArgs(BaseModel):
    pass


class ListGroupPlansArgs(BaseModel):
    group_id: str


class GetPlanArgs(BaseModel):
    plan_id: str


class ListPlanBucketsArgs(BaseModel):
    plan_id: str


class ListPlanLabelsArgs(BaseModel):
    plan_id: str


class ListPlanTasksArgs(BaseModel):
    plan_id: str


class ListBucketTasksArgs(BaseModel):
    bucket_id: str


class GetTaskDetailsArgs(BaseModel):
    task_id: str


class CreateTaskArgs(BaseModel):
    plan_id: str
    title: str
    bucket_id: str | None = None
    assignee_ids: list[str] | None = None
    due_date: str | None = None
    start_date: str | None = None
    percent_complete: int | None = None
    priority: int | None = None


class UpdateTaskArgs(BaseModel):
    task_id: str
    etag: str
    title: str | None = None
    bucket_id: str | None = None
    due_date: str | None = None
    start_date: str | None = None
    percent_complete: int | None = None
    priority: int | None = None
    assignee_ids: list[str] | None = None


class UpdateTaskDetailsArgs(BaseModel):
    task_id: str
    etag: str
    description: str | None = None
    checklist: list[dict[str, Any]] | None = None


class DeleteTaskArgs(BaseModel):
    task_id: str
    etag: str


class CreateBucketArgs(BaseModel):
    plan_id: str
    name: str


class CreatePlanArgs(BaseModel):
    group_id: str
    title: str


# ── Read actions (eager — execute immediately) ─────────

def list_my_tasks(
    connection_id: str | None = None,
) -> list[PlannerTask]:
    """List ONLY the tasks assigned to the signed-in user, across all plans

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMyTasksArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_my_tasks", _args)
    return [PlannerTask(**item) for item in data]


def list_group_plans(
    group_id: str,
    connection_id: str | None = None,
) -> list[PlannerPlan]:
    """List the plans owned by a Microsoft 365 group (= a Teams team)

    group_id: Microsoft 365 group ID. A Teams team id IS its group id — get one from teams.list_joined_teams.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListGroupPlansArgs(group_id=group_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_group_plans", _args)
    return [PlannerPlan(**item) for item in data]


def get_plan(
    plan_id: str,
    connection_id: str | None = None,
) -> PlannerPlan:
    """Fetch one plan by ID (title, owning group, etag)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetPlanArgs(plan_id=plan_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.get_plan", _args)
    return PlannerPlan(**data)


def list_plan_buckets(
    plan_id: str,
    connection_id: str | None = None,
) -> list[PlannerBucket]:
    """List the buckets (columns) of a plan

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPlanBucketsArgs(plan_id=plan_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_plan_buckets", _args)
    return [PlannerBucket(**item) for item in data]


def list_plan_labels(
    plan_id: str,
    connection_id: str | None = None,
) -> list[PlannerLabel]:
    """List a plan's label definitions (maps PlannerTask.label_ids to names)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPlanLabelsArgs(plan_id=plan_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_plan_labels", _args)
    return [PlannerLabel(**item) for item in data]


def list_plan_tasks(
    plan_id: str,
    connection_id: str | None = None,
) -> list[PlannerTask]:
    """List ALL tasks in a plan, every bucket (auto-paginated — returns the full set, not a page)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPlanTasksArgs(plan_id=plan_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_plan_tasks", _args)
    return [PlannerTask(**item) for item in data]


def list_bucket_tasks(
    bucket_id: str,
    connection_id: str | None = None,
) -> list[PlannerTask]:
    """List ALL tasks in one bucket (auto-paginated — use this to scope to a single column)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListBucketTasksArgs(bucket_id=bucket_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.list_bucket_tasks", _args)
    return [PlannerTask(**item) for item in data]


def get_task_details(
    task_id: str,
    connection_id: str | None = None,
) -> PlannerTaskDetails:
    """Fetch a task's description, checklist and reference links

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetTaskDetailsArgs(task_id=task_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("planner.get_task_details", _args)
    return PlannerTaskDetails(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _create_task_op(
    plan_id: str,
    title: str,
    bucket_id: str | None = None,
    assignee_ids: list[str] | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    percent_complete: int | None = None,
    priority: int | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_task Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateTaskArgs(plan_id=plan_id, title=title, bucket_id=bucket_id, assignee_ids=assignee_ids, due_date=due_date, start_date=start_date, percent_complete=percent_complete, priority=priority).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.create_task", args=_args)

def create_task(
    plan_id: str,
    title: str,
    bucket_id: str | None = None,
    assignee_ids: list[str] | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    percent_complete: int | None = None,
    priority: int | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a task in a plan (optionally in a bucket, with assignees)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    plan_id: Plan the task belongs to

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_task_op(
        plan_id=plan_id,
        title=title,
        bucket_id=bucket_id,
        assignee_ids=assignee_ids,
        due_date=due_date,
        start_date=start_date,
        percent_complete=percent_complete,
        priority=priority,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_task failed"))
    return result[0].get("data", {})

create_task.op = _create_task_op


def _update_task_op(
    task_id: str,
    etag: str,
    title: str | None = None,
    bucket_id: str | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    percent_complete: int | None = None,
    priority: int | None = None,
    assignee_ids: list[str] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_task Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateTaskArgs(task_id=task_id, etag=etag, title=title, bucket_id=bucket_id, due_date=due_date, start_date=start_date, percent_complete=percent_complete, priority=priority, assignee_ids=assignee_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.update_task", args=_args)

def update_task(
    task_id: str,
    etag: str,
    title: str | None = None,
    bucket_id: str | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    percent_complete: int | None = None,
    priority: int | None = None,
    assignee_ids: list[str] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update a task — title, bucket, dates, %complete, assignees

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    etag: The task's current etag (from a read). Sent as If-Match; a stale etag fails with 412 — re-read and retry.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_task_op(
        task_id=task_id,
        etag=etag,
        title=title,
        bucket_id=bucket_id,
        due_date=due_date,
        start_date=start_date,
        percent_complete=percent_complete,
        priority=priority,
        assignee_ids=assignee_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_task failed"))
    return result[0].get("data", {})

update_task.op = _update_task_op


def _update_task_details_op(
    task_id: str,
    etag: str,
    description: str | None = None,
    checklist: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_task_details Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateTaskDetailsArgs(task_id=task_id, etag=etag, description=description, checklist=checklist).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.update_task_details", args=_args)

def update_task_details(
    task_id: str,
    etag: str,
    description: str | None = None,
    checklist: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Set a task's description and/or replace its checklist

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    etag: The details object's etag (from get_task_details). Sent as If-Match.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_task_details_op(
        task_id=task_id,
        etag=etag,
        description=description,
        checklist=checklist,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_task_details failed"))
    return result[0].get("data", {})

update_task_details.op = _update_task_details_op


def _delete_task_op(
    task_id: str,
    etag: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_task Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteTaskArgs(task_id=task_id, etag=etag).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.delete_task", args=_args)

def delete_task(
    task_id: str,
    etag: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a task

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    etag: The task's current etag (from a read). Sent as If-Match.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_task_op(
        task_id=task_id,
        etag=etag,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_task failed"))
    return result[0].get("data", {})

delete_task.op = _delete_task_op


def _create_bucket_op(
    plan_id: str,
    name: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_bucket Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateBucketArgs(plan_id=plan_id, name=name).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.create_bucket", args=_args)

def create_bucket(
    plan_id: str,
    name: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a bucket (column) in a plan

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_bucket_op(
        plan_id=plan_id,
        name=name,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_bucket failed"))
    return result[0].get("data", {})

create_bucket.op = _create_bucket_op


def _create_plan_op(
    group_id: str,
    title: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_plan Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreatePlanArgs(group_id=group_id, title=title).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="planner.create_plan", args=_args)

def create_plan(
    group_id: str,
    title: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a plan owned by a Microsoft 365 group

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    group_id: Microsoft 365 group that will own the plan. The signed-in user MUST be a member of it.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_plan_op(
        group_id=group_id,
        title=title,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_plan failed"))
    return result[0].get("data", {})

create_plan.op = _create_plan_op
