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
import { createRedisRateLimitStore } from "@fretik/shared/lib/rate-limit";
import { createWorkflowRealtimeToken } from "@fretik/shared/lib/trigger-client";
import {
  paramsIdSchema,
  paramsListSchema,
} from "@fretik/shared/schemas/common/params";
import {
  responseAlreadyExistSchema,
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
  CriterionBacktestRequestSchema,
  CriterionBacktestResponseSchema,
  RunWorkflowRequestSchema,
  UpdateWorkflowSchema,
  WorkflowActiveRunSchema,
  WorkflowResponseSchema,
  WorkflowRunResponseSchema,
} from "@fretik/shared/schemas/workflows";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { activateWorkflow } from "@fretik/shared/services/workflows/activate";
import { archiveWorkflow } from "@fretik/shared/services/workflows/archive";
import { backtestCriterion } from "@fretik/shared/services/workflows/backtest-criterion";
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
import { overrideFilteredWorkflowRun } from "@fretik/shared/services/workflows/override-filtered-run";
import { pauseWorkflow } from "@fretik/shared/services/workflows/pause";
import { serializeWorkflowRun } from "@fretik/shared/services/workflows/serialize";
import { updateWorkflow } from "@fretik/shared/services/workflows/update";
import type { WorkflowRequester } from "@fretik/shared/services/workflows/visibility";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Workflows — autonomous agents (definitions + runs). Thin wrappers over
 * `@fretik/shared/services/workflows/*`; execution itself is driven by
 * Trigger.dev against the AI service (see the root plan). The frontend
 * watches live runs through Trigger Realtime with the scoped token minted
 * by `POST /realtime-token`; this API stays the source of truth for
 * definitions, run history, and the Stop action.
 */

const workflowRoutes = new OpenAPIHono<HonoLoggedAppType>();
workflowRoutes.use("*", authMiddleware);

/** A private (user-scoped) workflow is visible only to its owner — except
 * org admins/owners, who see every workflow for governance. */
const resolveRequester = async (
  user: { id: string },
  team: { organizationId: string },
): Promise<WorkflowRequester> => ({
  userId: user.id,
  isAdmin: await isOrgAdmin(team.organizationId, user.id),
});

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
  summary: "List the team's workflows",
  tags: ["Workflows"],
  request: {
    query: z.object({
      includeArchived: z.coerce.boolean().optional().default(false),
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
  summary: "Create a workflow (draft)",
  tags: ["Workflows"],
  request: {
    body: {
      content: { "application/json": { schema: CreateWorkflowSchema } },
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

const listRunsQuerySchema = paramsListSchema.extend({
  hideFiltered: z.enum(["true", "false"]).optional().openapi({
    description:
      "`true` leaves out the launches the trigger gate filtered out; the count follows.",
  }),
});

const listRunsRoute = createRoute({
  method: "get",
  path: "/{id}/runs",
  summary: "List a workflow's runs (paginated)",
  tags: ["Workflows"],
  request: { params: paramsIdSchema, query: listRunsQuerySchema },
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

const criterionBacktestRoute = createRoute({
  method: "post",
  path: "/{id}/criterion/backtest",
  summary: "Test a trigger criterion on recent events",
  description:
    "Asks the trigger gate's own question about the workflow's last matching events (up to 20) and returns, per event, whether it would run or be filtered out. Uses the criterion and trigger sent, saved or not. Records nothing. 400 when the criterion would be refused at activation; 429 past 5 tests a minute.",
  tags: ["Workflows"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: CriterionBacktestRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: CriterionBacktestResponseSchema },
      },
      description: "One verdict per replayed event, newest first",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const runAnywayRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/run-anyway",
  summary: "Start a run the trigger gate filtered out",
  description:
    "Overrides a `filtered` launch and starts it. The filtered row is replaced atomically — it holds the (workflow, source event) identity that dedups event runs — and the decision it carried is stamped `overridden` on the new run, so the refusal stays on the record of the launch that overruled it. 409 when someone already started it. This is also the only signal there is for a gate false negative.",
  tags: ["Workflows"],
  request: { params: runIdParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkflowRunResponseSchema } },
      description: "The started run",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseAlreadyExistSchema,
    ...responseInternalErrorSchema,
  },
});

const transcriptRoute = createRoute({
  method: "get",
  path: "/runs/{runId}/transcript",
  summary: "Fetch a run's agent transcript",
  description:
    "The run's conversation messages, read-only. Authorized through the run's team (workflow conversations have no member roster).",
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
  path: "/realtime-token",
  summary: "Mint a Trigger.dev Realtime token",
  description:
    "Scoped public access token for the browser to subscribe to this team's workflow runs (tag `team:<id>`) via Trigger Realtime. Expires after 1 h — re-mint on demand.",
  tags: ["Workflows"],
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
        "Public access token, Trigger API base URL, and the team tag to subscribe to",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ---- Handlers --------------------------------------------------------

workflowRoutes.openapi(listRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { includeArchived } = c.req.valid("query");
  const requester = await resolveRequester(user, team);
  const data = await listWorkflows({
    teamId: team.id,
    includeArchived,
    requester,
  });
  return c.json({ data }, 200);
});

workflowRoutes.openapi(createRouteDef, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const body = c.req.valid("json");
  const workflow = await createWorkflow({
    organizationId: team.organizationId,
    teamId: team.id,
    createdByUserId: user.id,
    input: body,
  });
  return c.json(workflow, 201);
});

// Registered before `getRoute` — its `/{id}` param would otherwise swallow
// the static `/active-runs` path (Hono matches routes in registration order).
workflowRoutes.openapi(activeRunsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const requester = await resolveRequester(user, team);
  const data = await listActiveWorkflowRuns({ teamId: team.id, requester });
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
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const workflow = await getWorkflow({ id, teamId: team.id, requester });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(updateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const requester = await resolveRequester(user, team);
  const workflow = await updateWorkflow({
    id,
    teamId: team.id,
    input: body,
    requester,
  });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(archiveRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const workflow = await archiveWorkflow({ id, teamId: team.id, requester });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(deleteRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const workflow = await deleteWorkflow({ id, teamId: team.id, requester });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(activateRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const workflow = await activateWorkflow({ id, teamId: team.id, requester });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(pauseRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const workflow = await pauseWorkflow({ id, teamId: team.id, requester });
  if (!workflow) return throwHttpError(404, notFound("Workflow not found"));
  return c.json(workflow, 200);
});

workflowRoutes.openapi(runRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const requester = await resolveRequester(user, team);

  const workflow = await getWorkflowRow({ id, teamId: team.id, requester });
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
    triggeredByUserId: user.id,
    isTest: body.isTest,
  });
  return c.json(run, 201);
});

workflowRoutes.openapi(listRunsRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { hideFiltered, ...query } = c.req.valid("query");
  const requester = await resolveRequester(user, team);
  const result = await listWorkflowRuns({
    workflowId: id,
    teamId: team.id,
    params: query,
    requester,
    hideFiltered: hideFiltered === "true",
  });
  return c.json(result, 200);
});

/**
 * Test the condition — replays the criterion over the workflow's recent
 * matching events. Every call spends up to twenty decisions, so it is capped
 * per person per workflow: enough to iterate on a sentence, not enough to
 * turn a button into a load generator.
 */
workflowRoutes.use(
  "/:id/criterion/backtest",
  rateLimiter<HonoLoggedAppType>({
    windowMs: 60_000,
    limit: 5,
    standardHeaders: "draft-6",
    keyGenerator: (c) => `${c.get("user").id}:${c.req.param("id") ?? ""}`,
    store: createRedisRateLimitStore<HonoLoggedAppType>("rl:criterion-test:"),
    requestPropertyName: "rateLimitCriterionTest",
  }),
);

workflowRoutes.openapi(criterionBacktestRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const requester = await resolveRequester(user, team);
  const result = await backtestCriterion({
    workflowId: id,
    teamId: team.id,
    organizationId: team.organizationId,
    criterion: body.criterion,
    ...(body.triggerConfig !== undefined
      ? { triggerConfig: body.triggerConfig }
      : {}),
    requester,
  });
  return c.json(result, 200);
});

workflowRoutes.openapi(getRunRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { runId } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const run = await getWorkflowRunRow({
    id: runId,
    teamId: team.id,
    requester,
  });
  if (!run) return throwHttpError(404, notFound("Run not found"));
  return c.json(serializeWorkflowRun(run), 200);
});

workflowRoutes.openapi(stopRunRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { runId } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const run = await cancelWorkflowRun({ runId, teamId: team.id, requester });
  if (!run) return throwHttpError(404, notFound("Run not found"));
  return c.json(run, 200);
});

workflowRoutes.openapi(runAnywayRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { runId } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  // A private workflow's filtered run is no more startable by a teammate than
  // its normal runs are visible to them, hence the same requester the read
  // routes resolve.
  const run = await overrideFilteredWorkflowRun({
    runId,
    teamId: team.id,
    userId: user.id,
    requester,
  });
  return c.json(run, 200);
});

workflowRoutes.openapi(transcriptRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  const { runId } = c.req.valid("param");
  const requester = await resolveRequester(user, team);
  const run = await getWorkflowRunRow({
    id: runId,
    teamId: team.id,
    requester,
  });
  if (!run) return throwHttpError(404, notFound("Run not found"));
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
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const { token, url, tag } = await createWorkflowRealtimeToken(team.id);
  return c.json({ token, url, tag }, 200);
});

export { workflowRoutes };
