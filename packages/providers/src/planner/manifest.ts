import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Microsoft Planner provider manifest — task & project management via
 * Microsoft Graph v1.0. 12 actions: read a user's tasks and a team's plans,
 * drill into a plan's buckets/tasks/details, and create/update/delete tasks
 * plus create buckets and plans.
 *
 * Decisions (plan `je-veux-rajouter-un-shiny-crayon.md`):
 *  - Backed by the Nango `microsoft-planner` provider (delegated user
 *    permissions). Called through `nango-proxy`.
 *  - Minimal scopes, NO tenant admin consent: `Tasks.ReadWrite` is the
 *    least-privileged Graph permission for every endpoint we use — including
 *    `GET /groups/{id}/planner/plans` and `POST /planner/plans` (Group.Read.All
 *    is only a higher-privileged alternative, so we skip it). Any user can
 *    self-connect Planner without an admin.
 *  - Group discovery is delegated to the Teams integration (a Teams team id
 *    IS its Microsoft 365 group id) or a user-supplied group id — we do NOT
 *    request Group.Read.All just to enumerate groups.
 *
 * ETags: Planner versions every resource with `@odata.etag`. PATCH and DELETE
 * REQUIRE an `If-Match: <etag>` header (HTTP 412 otherwise). Read actions
 * surface `etag`; the write mappers project the agent-supplied `etag` into the
 * `If-Match` header (see `mappers.ts`). POST creates need no etag.
 */
export const plannerManifest: ProviderManifest = {
  key: "planner",
  displayName: "Microsoft Planner",
  description:
    "Microsoft Planner — read tasks and plans; create, update, and delete tasks; manage buckets and plans",
  nangoProviderConfigKey: "microsoft-planner",
  icon: "/app-icons/microsoft-planner.svg",
  transport: { kind: "nango-proxy" },
  // Root "productivity" drives the settings filter; "tasks" tells the agent
  // this provider substitutes for any task / to-do request. NOT a
  // communication provider — no persona option, no voice boilerplate.
  categories: ["productivity", "tasks"],
  // Three delegated scopes, none requiring admin consent. `Tasks.ReadWrite`
  // covers all task/plan/bucket read+write; `User.Read` resolves `/me`;
  // `offline_access` gives Nango refresh tokens.
  scopes: ["offline_access", "User.Read", "Tasks.ReadWrite"],

  types: {
    PlannerTask: {
      id: { type: "string" },
      etag: {
        type: "string",
        description:
          "Concurrency token (@odata.etag). Pass it back as `etag` on update_task / delete_task — a stale value fails with 412, re-read the task to refresh.",
      },
      title: { type: "string" },
      plan_id: { type: "string" },
      bucket_id: {
        type: "string",
        optional: true,
        description: "Bucket (column) the task sits in, when assigned to one",
      },
      percent_complete: {
        type: "integer",
        description: "0 = not started, 50 = in progress, 100 = completed",
      },
      priority: {
        type: "integer",
        optional: true,
        description: "0–10; 1 urgent, 3 important, 5 medium, 9 low",
      },
      due_date: { type: "datetime", optional: true },
      start_date: { type: "datetime", optional: true },
      assignee_ids: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description: "Azure AD user IDs the task is assigned to",
      },
      has_description: {
        type: "boolean",
        description:
          "True when the task carries a description — fetch it with get_task_details",
      },
      created_at: { type: "datetime" },
    },
    PlannerTaskDetails: {
      id: { type: "string" },
      etag: {
        type: "string",
        description:
          "Concurrency token for the details object — pass back as `etag` on update_task_details.",
      },
      description: { type: "string", optional: true },
      checklist: {
        type: "array",
        items: {
          type: "object",
          fields: {
            id: { type: "string" },
            title: { type: "string" },
            is_checked: { type: "boolean" },
          },
        },
      },
      references: {
        type: "array",
        items: {
          type: "object",
          fields: {
            url: { type: "string" },
            alias: { type: "string", optional: true },
          },
        },
      },
    },
    PlannerPlan: {
      id: { type: "string" },
      etag: { type: "string" },
      title: { type: "string" },
      group_id: {
        type: "string",
        optional: true,
        description: "Microsoft 365 group that owns the plan",
      },
      created_at: { type: "datetime" },
    },
    PlannerBucket: {
      id: { type: "string" },
      etag: { type: "string" },
      name: { type: "string" },
      plan_id: { type: "string" },
      order_hint: { type: "string", optional: true },
    },
    WriteResult: {
      id: { type: "string", optional: true },
      etag: { type: "string", optional: true },
    },
  },

  actions: [
    // ─────────────────────────── Reads ─────────────────────────────
    {
      name: "list_my_tasks",
      kind: "read",
      summary: "List the tasks assigned to the signed-in user across all plans",
      endpoint: { method: "GET", path: "/v1.0/me/planner/tasks" },
      params: {},
      returns: { list: "PlannerTask" },
      response: "taskList",
    },
    {
      name: "list_group_plans",
      kind: "read",
      summary: "List the plans owned by a Microsoft 365 group (= a Teams team)",
      endpoint: {
        method: "GET",
        path: "/v1.0/groups/{group_id}/planner/plans",
      },
      params: {
        group_id: {
          type: "string",
          in: "path",
          description:
            "Microsoft 365 group ID. A Teams team id IS its group id — get one from teams.list_joined_teams.",
        },
      },
      returns: { list: "PlannerPlan" },
      response: "planList",
    },
    {
      name: "get_plan",
      kind: "read",
      summary: "Fetch one plan by ID (title, owning group, etag)",
      endpoint: { method: "GET", path: "/v1.0/planner/plans/{plan_id}" },
      params: { plan_id: { type: "string", in: "path" } },
      returns: { ref: "PlannerPlan" },
      response: "plan",
    },
    {
      name: "list_plan_buckets",
      kind: "read",
      summary: "List the buckets (columns) of a plan",
      endpoint: {
        method: "GET",
        path: "/v1.0/planner/plans/{plan_id}/buckets",
      },
      params: { plan_id: { type: "string", in: "path" } },
      returns: { list: "PlannerBucket" },
      response: "bucketList",
    },
    {
      name: "list_plan_tasks",
      kind: "read",
      summary:
        "List every task in a plan (each carries its bucket_id and etag)",
      endpoint: { method: "GET", path: "/v1.0/planner/plans/{plan_id}/tasks" },
      params: { plan_id: { type: "string", in: "path" } },
      returns: { list: "PlannerTask" },
      response: "taskList",
    },
    {
      name: "get_task_details",
      kind: "read",
      summary: "Fetch a task's description, checklist and reference links",
      endpoint: {
        method: "GET",
        path: "/v1.0/planner/tasks/{task_id}/details",
      },
      params: { task_id: { type: "string", in: "path" } },
      returns: { ref: "PlannerTaskDetails" },
      response: "taskDetails",
    },

    // ─────────────────────────── Writes ────────────────────────────
    {
      name: "create_task",
      kind: "write",
      summary:
        "Create a task in a plan (optionally in a bucket, with assignees)",
      endpoint: { method: "POST", path: "/v1.0/planner/tasks" },
      params: {
        plan_id: { type: "string", description: "Plan the task belongs to" },
        title: { type: "string", excludeFromHash: true },
        bucket_id: {
          type: "string",
          optional: true,
          description: "Bucket (column) to place the task in",
        },
        assignee_ids: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description:
            "Azure AD user IDs to assign (NOT emails — resolve with teams.find_user)",
        },
        due_date: { type: "datetime", optional: true },
        start_date: { type: "datetime", optional: true },
        percent_complete: {
          type: "integer",
          optional: true,
          description: "0, 50 or 100",
        },
        priority: { type: "integer", optional: true, description: "0–10" },
      },
      returns: { ref: "WriteResult" },
      request: "createTask",
      response: "writeResult",
    },
    {
      name: "update_task",
      kind: "write",
      summary: "Update a task — title, bucket, dates, %complete, assignees",
      endpoint: { method: "PATCH", path: "/v1.0/planner/tasks/{task_id}" },
      params: {
        task_id: { type: "string", in: "path" },
        etag: {
          type: "string",
          description:
            "The task's current etag (from a read). Sent as If-Match; a stale etag fails with 412 — re-read and retry.",
        },
        title: { type: "string", optional: true, excludeFromHash: true },
        bucket_id: { type: "string", optional: true },
        due_date: { type: "datetime", optional: true },
        start_date: { type: "datetime", optional: true },
        percent_complete: {
          type: "integer",
          optional: true,
          description: "0, 50 or 100",
        },
        priority: { type: "integer", optional: true, description: "0–10" },
        assignee_ids: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description:
            "Replaces the assignee set. Azure AD user IDs (resolve with teams.find_user).",
        },
      },
      returns: { ref: "WriteResult" },
      request: "updateTask",
      response: "writeResult",
    },
    {
      name: "update_task_details",
      kind: "write",
      summary: "Set a task's description and/or replace its checklist",
      endpoint: {
        method: "PATCH",
        path: "/v1.0/planner/tasks/{task_id}/details",
      },
      params: {
        task_id: { type: "string", in: "path" },
        etag: {
          type: "string",
          description:
            "The details object's etag (from get_task_details). Sent as If-Match.",
        },
        description: { type: "string", optional: true, excludeFromHash: true },
        checklist: {
          type: "array",
          optional: true,
          excludeFromHash: true,
          description:
            "Replaces the checklist. Each item: { title }. Omit to leave the checklist unchanged.",
          items: {
            type: "object",
            fields: { title: { type: "string" } },
          },
        },
      },
      returns: { ref: "WriteResult" },
      request: "updateTaskDetails",
      response: "writeResult",
    },
    {
      name: "delete_task",
      kind: "write",
      summary: "Delete a task",
      endpoint: { method: "DELETE", path: "/v1.0/planner/tasks/{task_id}" },
      params: {
        task_id: { type: "string", in: "path" },
        etag: {
          type: "string",
          description:
            "The task's current etag (from a read). Sent as If-Match.",
        },
      },
      returns: { ref: "WriteResult" },
      request: "deleteTask",
      response: "writeResult",
    },
    {
      name: "create_bucket",
      kind: "write",
      summary: "Create a bucket (column) in a plan",
      endpoint: { method: "POST", path: "/v1.0/planner/buckets" },
      params: {
        plan_id: { type: "string" },
        name: { type: "string", excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
      request: "createBucket",
      response: "writeResult",
    },
    {
      name: "create_plan",
      kind: "write",
      summary: "Create a plan owned by a Microsoft 365 group",
      endpoint: { method: "POST", path: "/v1.0/planner/plans" },
      params: {
        group_id: {
          type: "string",
          description:
            "Microsoft 365 group that will own the plan. The signed-in user MUST be a member of it.",
        },
        title: { type: "string", excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
      request: "createPlan",
      response: "writeResult",
    },
  ],
};
