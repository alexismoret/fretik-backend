import type {
  ToolApprovalOperation,
  ToolApprovalRequest,
  ToolApprovalSummary,
} from "@fretik/shared/db/schema";
import { renderApprovalSummary } from "@fretik/shared/external-apps/i18n/render-summary";
import { getAction } from "@fretik/shared/external-apps/registry";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  forbidden,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import {
  approvalResponseSchema,
  grantApprovalRequestSchema,
  modifyAndGrantRequestSchema,
  operationSchemasResponseSchema,
  rejectApprovalRequestSchema,
  type ApprovalResponse,
  type OperationSchemasResponse,
} from "@fretik/shared/schemas/approvals";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { ERROR_CODES } from "@fretik/shared/schemas/errors";
import {
  executeAndMutateForGrant,
  mutateForReject,
} from "@fretik/shared/services/approvals/execute-decision";
import { getApprovalForCaller } from "@fretik/shared/services/approvals/get-by-id";
import { grantApproval } from "@fretik/shared/services/approvals/grant";
import { modifyAndGrantApproval } from "@fretik/shared/services/approvals/modify-and-grant";
import { rejectApproval } from "@fretik/shared/services/approvals/reject";
import { toWirePayload } from "@fretik/shared/services/approvals/to-wire-payload";
import { extractFrameworkArgs } from "@fretik/shared/services/external-apps/exec/framework-args";
import { resolveMcpWriteOp } from "@fretik/shared/services/external-apps/exec/mcp-plan";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { getTeamLocale } from "@fretik/shared/services/field-definitions/get-locale";
import { resumeRunFromApproval } from "@fretik/shared/services/workflows/resume-from-approval";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

/**
 * `/approvals/:id/*` — the unified approval flow for every kind:
 * `external_app_plan` (a `run_plan` write plan), `record_write` (object
 * records a workflow proposed), and `question` (a workflow's askUserQuestion).
 * One lifecycle (pending → granted → executing → consumed / rejected) drives
 * all three; the row's `kind` selects the payload and how grant executes.
 *
 *  GET    /:id                   Fetch a single approval (summary rendered in
 *                                the team's language for plans; raw `payload`
 *                                for the other kinds).
 *  POST   /:id/grant             Approve. Optional body: `answers` (question)
 *                                or `selectedIndexes` (record_write subset).
 *  POST   /:id/modify-and-grant  Plan only — approve with edited operations.
 *  POST   /:id/reject            Reject with an optional feedback note.
 *
 * Approvals never expire — the card stays actionable days later. Concurrent
 * grant/reject races are handled by the underlying atomic services.
 */

const approvalsRoutes = new OpenAPIHono<HonoLoggedAppType>();
approvalsRoutes.use("*", authMiddleware);

// ---- DTO mapper ------------------------------------------------------

const toDto = async (
  row: ToolApprovalRequest,
  teamId: string,
): Promise<ApprovalResponse> => {
  const lang = await getTeamLocale(teamId);
  return {
    id: row.id,
    conversationId: row.conversationId,
    turnId: row.turnId,
    kind: row.kind,
    status: row.status,
    itemCount: row.itemCount,
    summary:
      row.summary !== null ? renderApprovalSummary(row.summary, lang) : null,
    operations: row.operations,
    // Preview, not the whole list: a bulk record write holds one entry per
    // record. `itemCount` above carries the true total, so the card knows it is
    // looking at a slice. Grant still executes from the stored payload.
    payload: toWirePayload(row.payload),
    result: row.result ?? null,
    decisionFeedback: row.decisionFeedback,
    decisionAt: row.decisionAt,
    executedAt: row.executedAt,
    createdAt: row.createdAt,
  };
};

// ---- Modify-and-grant validation (external_app_plan only) -----------

/**
 * Validate edited operations against the manifest and rebuild the
 * structural summary. Mirrors the validation the dispatcher does on fresh
 * plans. Rejects the whole plan on any single failure so a user cannot
 * partially apply an invalid edit.
 */
const validateModifiedPlan = async (
  operations: ToolApprovalOperation[],
  teamId: string,
  userId: string,
): Promise<{
  operations: ToolApprovalOperation[];
  summary: ToolApprovalSummary;
}> => {
  const validatedOps: ToolApprovalOperation[] = [];
  const summaryOps: ToolApprovalSummary["operations"] = [];

  for (const op of operations) {
    const resolved = getAction(op.action);
    if (resolved === undefined) {
      // MCP write op — re-resolve against the connection snapshot (generic
      // summary). Autonomy is irrelevant here (validation only), so pass null.
      let mcp;
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential per-op resolve
        mcp = await resolveMcpWriteOp({ op, teamId, userId, autonomy: null });
      } catch (error) {
        return throwHttpError(400, {
          code: ERROR_CODES.EXTERNAL_APP_INVALID_ACTION,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      validatedOps.push({ action: op.action, args: mcp.storedArgs });
      summaryOps.push(mcp.summaryOp);
      continue;
    }
    if (resolved.action.kind !== "write") {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_PLAN_INVALID,
        message: `Action ${op.action} is not a write action`,
      });
    }
    if (resolved.summary === undefined) {
      return throwHttpError(500, {
        code: ERROR_CODES.EXTERNAL_APP_PLAN_INVALID,
        message: `Action ${op.action} has no summary mapper`,
      });
    }

    const { framework, action: actionArgs } = extractFrameworkArgs(op.args);
    let validated: Record<string, unknown>;
    try {
      validated = validateActionArgs(op.action, resolved.action, actionArgs);
    } catch (error) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_PLAN_INVALID,
        message: `Invalid args for ${op.action}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const storedArgs: Record<string, unknown> = { ...validated };
    if (framework.connection_id !== undefined) {
      storedArgs.connection_id = framework.connection_id;
    }
    validatedOps.push({ action: op.action, args: storedArgs });

    const part = resolved.summary(validated);
    summaryOps.push({
      providerKey: resolved.providerKey,
      action: resolved.action.name,
      titleKey: part.titleKey,
      titleParams: part.titleParams,
      fields: part.fields,
    });
  }

  const summary: ToolApprovalSummary = {
    titleKey: "default",
    titleParams: { count: validatedOps.length },
    operations: summaryOps,
  };
  return { operations: validatedOps, summary };
};

// ---- WRONG_STATUS recovery helper -----------------------------------

/**
 * Detect a `TOOL_APPROVAL_WRONG_STATUS` HTTPException. Grant / modify-and-grant
 * use it to recover from idempotent retries: a double-click or network retry
 * hits a non-pending row, which we catch, re-read, and fall through to the
 * (itself idempotent) execution path. Rejected rows still bubble the 409 —
 * that is a real conflict.
 */
const isWrongStatusError = (err: unknown): boolean => {
  if (!(err instanceof HTTPException)) return false;
  if (err.status !== 409) return false;
  try {
    const parsed = JSON.parse(err.message) as { code?: string };
    return parsed.code === ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS;
  } catch {
    return false;
  }
};

// ---- Routes ---------------------------------------------------------

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Fetch a tool approval request",
  description:
    "Returns the approval. For `external_app_plan` the `summary` is pre-rendered in the team's language and `operations` carries the raw ops for the Modify form; for `record_write` / `question` the structured `payload` drives the card. The frontend hits this whenever an approval card renders — including reloads days later.",
  tags: ["Approvals"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Approval",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const grantRoute = createRoute({
  method: "post",
  path: "/{id}/grant",
  summary: "Approve a pending request",
  description:
    "Transitions `pending` → `granted` and executes the decision per kind: a plan runs via Nango, a record_write creates the selected records, a question records its answers. Optional body: `answers` (question) or `selectedIndexes` (record_write subset; omitted = all).",
  tags: ["Approvals"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: grantApprovalRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Granted",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    409: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description:
        "Conflict — the approval was not in `pending` status (concurrent decision or stale UI).",
    },
    ...responseInternalErrorSchema,
  },
});

const modifyAndGrantRoute = createRoute({
  method: "post",
  path: "/{id}/modify-and-grant",
  summary: "Approve an external-app plan after editing one or more operations",
  description:
    "`external_app_plan` only. Validates each modified op against the provider manifest, rebuilds the summary, and transitions `pending` → `granted` with the new `operations`. The `lookup_hash` is NOT recomputed — the agent's identical re-run still matches the grant.",
  tags: ["Approvals"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: modifyAndGrantRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Plan modified and granted",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    409: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Conflict — the approval was not in `pending` status.",
    },
    ...responseInternalErrorSchema,
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/{id}/reject",
  summary: "Reject a pending request with an optional feedback note",
  description:
    "Transitions `pending` → `rejected`. The agent's next turn sees the rejection (plus feedback) substituted in its tool result and adapts; for a workflow the run resumes and can react to the refusal.",
  tags: ["Approvals"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: rejectApprovalRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Rejected",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    409: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Conflict — the approval was not in `pending` status.",
    },
    ...responseInternalErrorSchema,
  },
});

const operationSchemasRoute = createRoute({
  method: "get",
  path: "/{id}/operation-schemas",
  summary: "Param schemas of the actions this plan's operations call",
  description:
    "Feeds the Modify form: with a schema it renders real fields — labels, enums as selects, numeric bounds, nested objects and repeatable arrays of objects — instead of a raw JSON textarea. Fetched only when the form opens (a spec is per-action and unbounded, so it does not ride on the approval itself). Non-plan kinds and unresolvable actions return no entry; the form then infers inputs from each value's runtime type.",
  tags: ["Approvals"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: operationSchemasResponseSchema },
      },
      description: "Schemas keyed by qualified action name",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

// Workflow-run resume hook: when the decided approval belongs to a workflow
// run parked on a wait token, complete the token so the orchestrator loop
// continues. No-op for chat conversations. Soft-fail: a Trigger hiccup must
// not break the approval UX — the run stays parked (bounded by the token
// timeout) instead of the user losing their decision.
const resumeWorkflowIfParked = async (
  conversationId: string | null,
  decision: "approved" | "rejected",
): Promise<void> => {
  if (conversationId === null) return;
  try {
    await resumeRunFromApproval({ conversationId, decision });
  } catch (err) {
    console.error(
      "[approvals] workflow resume failed — the run stays parked on its wait token:",
      err instanceof Error ? err.message : err,
    );
  }
};

// ---- Handlers --------------------------------------------------------

approvalsRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const row = await getApprovalForCaller(id, team.id);
  return c.json(await toDto(row, team.id), 200);
});

approvalsRoutes.openapi(operationSchemasRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const row = await getApprovalForCaller(id, team.id);

  // Best-effort by design, unlike `validateModifiedPlan`: this feeds a form,
  // and a spec we cannot resolve costs the reviewer a nicer widget, never the
  // ability to review. An action resolved here is simply absent from the map.
  const schemas: OperationSchemasResponse["schemas"] = {};
  for (const op of row.operations ?? []) {
    if (schemas[op.action] !== undefined) continue;
    const resolved = getAction(op.action);
    if (resolved !== undefined) {
      schemas[op.action] = resolved.action.params;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential per-op resolve
      const mcp = await resolveMcpWriteOp({
        op,
        teamId: team.id,
        userId: user.id,
        autonomy: null,
      });
      schemas[op.action] = mcp.params;
    } catch {
      // Unknown action, connection gone, snapshot stale — no schema, no field.
    }
  }
  return c.json({ schemas }, 200);
});

approvalsRoutes.openapi(grantRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const decision = c.req.valid("json");
  // Status transition `pending → granted`. Tolerate WRONG_STATUS so a
  // double-click / retry lands in the idempotent execution path below.
  let approval: ToolApprovalRequest;
  try {
    approval = await grantApproval({ id, teamId: team.id, userId: user.id });
  } catch (err) {
    if (!isWrongStatusError(err)) throw err;
    approval = await getApprovalForCaller(id, team.id);
    if (approval.status === "rejected") throw err;
  }
  // Execute per kind + substitute the persisted tool output. After this,
  // the next agent turn sees the outcome in history and won't re-call.
  approval = await executeAndMutateForGrant({
    approval,
    teamId: team.id,
    decision,
  });
  await resumeWorkflowIfParked(approval.conversationId, "approved");
  return c.json(await toDto(approval, team.id), 200);
});

approvalsRoutes.openapi(modifyAndGrantRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { operations, summary } = await validateModifiedPlan(
    body.operations,
    team.id,
    user.id,
  );

  // Same idempotent recovery shape as grant.
  let approval: ToolApprovalRequest;
  try {
    approval = await modifyAndGrantApproval({
      id,
      teamId: team.id,
      userId: user.id,
      operations,
      summary,
    });
  } catch (err) {
    if (!isWrongStatusError(err)) throw err;
    approval = await getApprovalForCaller(id, team.id);
    if (approval.status === "rejected") throw err;
  }
  approval = await executeAndMutateForGrant({
    approval,
    teamId: team.id,
  });
  await resumeWorkflowIfParked(approval.conversationId, "approved");
  return c.json(await toDto(approval, team.id), 200);
});

approvalsRoutes.openapi(rejectRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  let approval: ToolApprovalRequest;
  try {
    approval = await rejectApproval({
      id,
      teamId: team.id,
      userId: user.id,
      feedback: body.feedback,
    });
  } catch (err) {
    if (!isWrongStatusError(err)) throw err;
    approval = await getApprovalForCaller(id, team.id);
    // Idempotent reject retry: already-rejected falls through to mutate.
    // granted/executing/consumed means the user actually approved — surface
    // the 409 so the frontend doesn't silently flip the UI.
    if (approval.status !== "rejected") throw err;
  }
  await mutateForReject(approval);
  await resumeWorkflowIfParked(approval.conversationId, "rejected");
  return c.json(await toDto(approval, team.id), 200);
});

export { approvalsRoutes };
