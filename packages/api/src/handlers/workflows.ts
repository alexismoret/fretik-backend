import { requireAccess } from "@fretik/shared/authz/access";
import { access, teamOfResource } from "@fretik/shared/authz/http";
import {
  requirePlacement,
  teamOfProject,
} from "@fretik/shared/authz/placement";
import type { UserPrincipal } from "@fretik/shared/authz/principal";
import type { WorkflowRun } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  badRequest,
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { createWorkflowRealtimeToken } from "@fretik/shared/lib/trigger-client";
import type { AccessLevel } from "@fretik/shared/schemas/access";
import {
  paramsIdSchema,
  paramsListSchema,
} from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseListSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  buildTriggerCatalog,
  TriggerCatalogSchema,
} from "@fretik/shared/schemas/workflow-triggers";
import {
  CreateWorkflowSchema,
  RunWorkflowRequestSchema,
  UpdateWorkflowSchema,
  WorkflowActiveRunSchema,
  WorkflowResponseSchema,
  WorkflowRunResponseSchema,
} from "@fretik/shared/schemas/workflows";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { activateWorkflow } from "@fretik/shared/services/workflows/activate";
import { archiveWorkflow } from "@fretik/shared/services/workflows/archive";
import { cancelWorkflowRun } from "@fretik/shared/services/workflows/cancel-run";
import { createWorkflow } from "@fretik/shared/services/workflows/create";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import { deleteWorkflow } from "@fretik/shared/services/workflows/delete";
import {
  getWorkflow,
  getWorkflowRow,
} from "@fretik/shared/services/workflows/get";
import { getWorkflowRunRow } from "@fretik/shared/services/workflows/get-run";
import { listWorkflows } from "@fretik/shared/services/workflows/list";
import { listActiveWorkflowRuns } from "@fretik/shared/services/workflows/list-active-runs";
import { listWorkflowRuns } from "@fretik/shared/services/workflows/list-runs";
import { pauseWorkflow } from "@fretik/shared/services/workflows/pause";
import { serializeWorkflowRun } from "@fretik/shared/services/workflows/serialize";
import { updateWorkflow } from "@fretik/shared/services/workflows/update";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

/**
 * Workflows — autonomous agents (definitions + runs). Thin wrappers over
 * `@fretik/shared/services/workflows/*`; execution itself is driven by
 * Trigger.dev against the AI service (see the root plan). The frontend
 * watches one workflow's live runs through Trigger Realtime with the token
 * minted by `POST /{id}/realtime-token`; this API stays the source of truth for
 * definitions, run history, and the Stop action.
 *
 * Each route on one workflow names the level it takes (`access.resource`):
 * view to read it and its runs, use to run or stop it, edit to change it,
 * full to turn it on or off, archive or delete it. A restricted workflow runs
 * as its owner, so for anyone else it stays at view (`authz/rules.ts`).
 */

const workflowRoutes = new OpenAPIHono<HonoLoggedAppType>();
workflowRoutes.use("*", authMiddleware);

/**
 * The run named in the path, for a caller who reaches its workflow at
 * `level`: 404 when the run or its workflow is out of sight, 403 with the
 * reason when the caller sees the workflow but may not do this with it. A run
 * is its workflow's: reading one takes `view`, stopping one takes `use` — a
 * restricted workflow's runs are its owner's to stop.
 */
const requireRun = async (params: {
  runId: string;
  principal: UserPrincipal;
  level: AccessLevel;
}): Promise<WorkflowRun> => {
  // In the caller's organization, not their open team: a workflow shared from
  // another team shows its runs where it opens.
  const run = await getWorkflowRunRow({
    id: params.runId,
    organizationId: params.principal.organizationId,
    principal: params.principal,
  });
  if (!run) return throwHttpError(404, notFound("Run not found"));
  await requireAccess({
    principal: params.principal,
    type: "workflow",
    id: run.workflowId,
    required: params.level,
    notFoundMessage: "Run not found",
  });
  return run;
};

const runIdParamSchema = z.object({
  runId: z.uuid().openapi({ param: { name: "runId", in: "path" } }),
});

const transcriptMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  parts: z.array(z.unknown()),
  metadata: z.unknown().optional(),
});

// ---- Routes ----------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "The active team's workflows the caller can see, or a project's (`projectId`, view on it): a restricted one only through its owner or a grant.",
  ),
  summary: "List the team's workflows",
  tags: ["Workflows"],
  request: {
    query: z.object({
      includeArchived: z.coerce.boolean().optional().default(false),
      projectId: z.uuid().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(WorkflowResponseSchema) }),
        },
      },
      description: "Workflows",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  middleware: access.handler(
    "Where it lands (`authz/placement.ts`): a project the caller takes part in (`projectId`), or the active team, which they contribute to.",
  ),
  summary: "Create a workflow (draft)",
  tags: ["Workflows"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateWorkflowSchema.extend({
            projectId: z.uuid().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Created workflow",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  middleware: access.resource("workflow", "view"),
  summary: "Fetch one workflow",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Workflow",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  middleware: access.resource("workflow", "edit"),
  summary: "Update a workflow definition",
  description:
    "Partial update. Changing a cron while ACTIVE does not silently re-schedule — pause and re-activate to apply trigger changes.",
  tags: ["Workflows"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: UpdateWorkflowSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Updated workflow",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const archiveRoute = createRoute({
  method: "post",
  path: "/{id}/archive",
  middleware: access.resource("workflow", "full"),
  summary: "Archive a workflow",
  description:
    "active/paused/draft → archived (reversible off-switch — run history stays). Drops the Trigger.dev schedule when one exists.",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Archived workflow",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  middleware: access.resource("workflow", "full"),
  summary: "Permanently delete an archived workflow",
  description:
    "Only archived workflows can be deleted (400 otherwise). Irreversibly removes the workflow, its full run history, run transcripts/conversations and their files.",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Deleted workflow",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const activateRoute = createRoute({
  method: "post",
  path: "/{id}/activate",
  middleware: access.resource("workflow", "full"),
  summary: "Activate a workflow",
  description:
    "draft/paused → active. Cron workflows get their Trigger.dev schedule created here (idempotent).",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Activated workflow",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const pauseRoute = createRoute({
  method: "post",
  path: "/{id}/pause",
  middleware: access.resource("workflow", "full"),
  summary: "Pause a workflow",
  description: "active → paused. Drops the Trigger.dev schedule.",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowResponseSchema } },
      description: "Paused workflow",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const runRoute = createRoute({
  method: "post",
  path: "/{id}/run",
  middleware: access.resource("workflow", "use"),
  summary: "Fire a run now",
  description:
    "Manual runs need an ACTIVE workflow; test runs (`isTest: true`) fire on drafts and paused workflows too — the builder's validation loop before activation.",
  tags: ["Workflows"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: RunWorkflowRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: WorkflowRunResponseSchema } },
      description: "Created run (already handed to Trigger.dev)",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const listRunsRoute = createRoute({
  method: "get",
  path: "/{id}/runs",
  middleware: access.resource("workflow", "view"),
  summary: "List a workflow's runs (paginated)",
  tags: ["Workflows"],
  request: { params: paramsIdSchema, query: paramsListSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(WorkflowRunResponseSchema),
        },
      },
      description: "Runs, newest first",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const activeRunsRoute = createRoute({
  method: "get",
  path: "/active-runs",
  middleware: access.session(
    "Live runs of the workflows the caller can see in the active team.",
  ),
  summary: "List the team's live runs",
  description:
    "Every non-terminal run (queued/running/needs_approval) across the team, for the live pulse on the workflow card list. Cheap — poll it while the list is open.",
  tags: ["Workflows"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(WorkflowActiveRunSchema) }),
        },
      },
      description: "Active runs",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const triggerCatalogRoute = createRoute({
  method: "get",
  path: "/trigger-catalog",
  middleware: access.session(
    "A static catalog of trigger kinds, the same for every member.",
  ),
  summary: "The trigger catalog — kinds + per-event-type editable parameters",
  description:
    "Static descriptor registry the workflow trigger editor renders and the chatbot introspects: every trigger kind and each triggerable event type's contextual filter params. Cache it — it rarely changes.",
  tags: ["Workflows"],
  responses: {
    200: {
      content: { "application/json": { schema: TriggerCatalogSchema } },
      description: "Trigger catalog",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRunRoute = createRoute({
  method: "get",
  path: "/runs/{runId}",
  middleware: access.handler(
    "A run is read with view on its workflow (requireRun).",
  ),
  summary: "Fetch one run",
  tags: ["Workflows"],
  request: { params: runIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowRunResponseSchema } },
      description: "Run",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const stopRunRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/stop",
  middleware: access.handler(
    "Stopping a run takes use on its workflow (requireRun).",
  ),
  summary: "Stop a run",
  description:
    "Cancels the Trigger.dev run (including a parked approval wait), aborts any in-flight turn, and closes the run `canceled`. Idempotent.",
  tags: ["Workflows"],
  request: { params: runIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowRunResponseSchema } },
      description: "Canceled run",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const transcriptRoute = createRoute({
  method: "get",
  path: "/runs/{runId}/transcript",
  middleware: access.handler(
    "A run's transcript is read with view on its workflow (requireRun).",
  ),
  summary: "Fetch a run's agent transcript",
  description:
    "The run's conversation messages, read-only. Authorized through the run's workflow (a workflow conversation has no member roster).",
  tags: ["Workflows"],
  request: { params: runIdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ messages: z.array(transcriptMessageSchema) }),
        },
      },
      description: "Transcript messages (UIMessage shape)",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const realtimeTokenRoute = createRoute({
  method: "post",
  path: "/{id}/realtime-token",
  middleware: access.resource("workflow", "view"),
  summary: "Mint a Trigger.dev Realtime token for one workflow",
  description:
    "Scoped public access token for the browser to follow this workflow's runs (tag `workflow:<id>`) via Trigger Realtime, without payloads or outputs. Expires after 1 h — re-mint on demand.",
  tags: ["Workflows"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string(),
            url: z.string(),
            tag: z.string(),
          }),
        },
      },
      description:
        "Public access token, Trigger API base URL, and the workflow tag to subscribe to",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

workflowRoutes.openapi(listRoute, async (c) => {
  const principal = c.get("principal");
  const { includeArchived, projectId } = c.req.valid("query");
  const teamId =
    projectId === undefined
      ? c.get("team")?.id
      : await teamOfProject(principal, projectId);
  if (!teamId) return c.json(teamRequired(), 403);
  const data = await listWorkflows({
    teamId,
    includeArchived,
    principal,
    ...(projectId === undefined ? {} : { projectId }),
  });
  return c.json({ data }, 200);
});

workflowRoutes.openapi(createRouteDef, async (c) => {
  const principal = c.get("principal");
  const { projectId, ...input } = c.req.valid("json");
  const placement = await requirePlacement({
    principal,
    activeTeamId: c.get("team")?.id,
    projectId,
  });
  const workflow = await createWorkflow({
    organizationId: principal.organizationId,
    teamId: placement.teamId,
    projectId: placement.projectId,
    createdByUserId: c.get("user").id,
    principal,
    input,
  });
  return c.json(workflow, 201);
});

// Registered before `getRoute` — its `/{id}` param would otherwise swallow
// the static `/active-runs` path (Hono matches routes in registration order).
workflowRoutes.openapi(activeRunsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const data = await listActiveWorkflowRuns({
    teamId: team.id,
    principal: c.get("principal"),
  });
  return c.json({ data }, 200);
});

// Registered before `getRoute` — its `/{id}` param would otherwise swallow the
// static `/trigger-catalog` path (Hono matches routes in registration order).
workflowRoutes.openapi(triggerCatalogRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  return c.json(buildTriggerCatalog(), 200);
});

workflowRoutes.openapi(getRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const workflow = await getWorkflow({
    id,
    teamId,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(updateRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const workflow = await updateWorkflow({
    id,
    teamId,
    input: body,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(archiveRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const workflow = await archiveWorkflow({
    id,
    teamId,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(deleteRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const workflow = await deleteWorkflow({
    id,
    teamId,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(activateRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const workflow = await activateWorkflow({
    id,
    teamId,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(pauseRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const workflow = await pauseWorkflow({
    id,
    teamId,
    principal: c.get("principal"),
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(runRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const workflow = await getWorkflowRow({
    id,
    teamId,
    principal: c.get("principal"),
    level: "use",
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  if (workflow.status === "archived") {
    return throwHttpError(400, badRequest("Archived workflows cannot run."));
  }
  if (!body.isTest && workflow.status !== "active") {
    return throwHttpError(
      400,
      badRequest("Activate the workflow first, or fire a test run."),
    );
  }

  const run = await createWorkflowRun({
    workflow,
    // A form workflow launched here IS a form submission by a member, so the
    // run reads as `form` (aligns with the builder's `run_test` and fixes the
    // trigger card's origin label). Everything else was launched by hand.
    triggerType: workflow.triggerType === "form" ? "form" : "manual",
    triggerPayload: body.payload,
    triggeredByUserId: c.get("user").id,
    isTest: body.isTest,
  });
  return c.json(run, 201);
});

workflowRoutes.openapi(listRunsRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { id } = c.req.valid("param");
  const query = c.req.valid("query");
  const result = await listWorkflowRuns({
    workflowId: id,
    teamId,
    params: query,
    principal: c.get("principal"),
  });
  return c.json(result, 200);
});

workflowRoutes.openapi(getRunRoute, async (c) => {
  const { runId } = c.req.valid("param");
  const run = await requireRun({
    runId,
    principal: c.get("principal"),
    level: "view",
  });
  return c.json(serializeWorkflowRun(run), 200);
});

workflowRoutes.openapi(stopRunRoute, async (c) => {
  const { runId } = c.req.valid("param");
  const principal = c.get("principal");
  const { teamId } = await requireRun({ runId, principal, level: "use" });
  const run = await cancelWorkflowRun({ runId, teamId, principal });
  if (!run) return throwHttpError(404, notFound("Run not found"));
  return c.json(run, 200);
});

workflowRoutes.openapi(transcriptRoute, async (c) => {
  const { runId } = c.req.valid("param");
  const run = await requireRun({
    runId,
    principal: c.get("principal"),
    level: "view",
  });
  if (run.conversationId === null) return c.json({ messages: [] }, 200);
  // Flatten to the wire shape: UIMessage's `parts` union is enormous and
  // blows the type checker against the zod-inferred response — widening to
  // `unknown[]` here keeps the check shallow (the frontend re-narrows).
  const messages = (await getConversationMessages(run.conversationId)).map(
    (m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts.map((p): unknown => p),
      ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
    }),
  );
  return c.json({ messages }, 200);
});

workflowRoutes.openapi(realtimeTokenRoute, async (c) => {
  const { token, url, tag } = await createWorkflowRealtimeToken(
    c.req.valid("param").id,
  );
  return c.json({ token, url, tag }, 200);
});

export { workflowRoutes };
