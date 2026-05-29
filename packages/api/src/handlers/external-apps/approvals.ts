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
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { ERROR_CODES } from "@fretik/shared/schemas/errors";
import {
  approvalResponseSchema,
  modifyAndGrantRequestSchema,
  rejectApprovalRequestSchema,
  type ApprovalResponse,
} from "@fretik/shared/schemas/external-apps";
import { getApprovalForCaller } from "@fretik/shared/services/external-apps/approvals/get-by-id";
import { grantApproval } from "@fretik/shared/services/external-apps/approvals/grant";
import { modifyAndGrantApproval } from "@fretik/shared/services/external-apps/approvals/modify-and-grant";
import { rejectApproval } from "@fretik/shared/services/external-apps/approvals/reject";
import { extractFrameworkArgs } from "@fretik/shared/services/external-apps/exec/framework-args";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { getTeamLocale } from "@fretik/shared/services/field-definitions/get-locale";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  executeAndMutateForGrant,
  mutateForReject,
} from "./_approval-execution";

/**
 * `/external-apps/approvals/:id/*` — the user-facing approval card flow.
 *
 *  GET    /:id                   Fetch a single approval with the summary
 *                                pre-rendered in the team's language and
 *                                the raw `operations` for the Modify form.
 *  POST   /:id/grant             Approve as-is.
 *  POST   /:id/modify-and-grant  Approve with edited operations (lookupHash
 *                                stays frozen — the agent's same code on
 *                                re-run still matches the grant).
 *  POST   /:id/reject            Reject with an optional feedback note.
 *
 * Approvals never expire — the user can come back days later and the
 * card stays actionable. Concurrent grant/reject races are handled by
 * the underlying services (atomic UPDATE … WHERE status = 'pending').
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
    status: row.status,
    itemCount: row.itemCount,
    summary: renderApprovalSummary(row.summary, lang),
    operations: row.operations,
    result: row.result ?? null,
    decisionFeedback: row.decisionFeedback,
    decisionAt: row.decisionAt,
    executedAt: row.executedAt,
    createdAt: row.createdAt,
  };
};

// ---- Modify-and-grant validation ------------------------------------

/**
 * Validate edited operations against the manifest and rebuild the
 * structural summary. Mirrors the validation the dispatcher does on
 * fresh plans — same Zod schemas (`validateActionArgs`), same framework
 * args split (`extractFrameworkArgs`), same summary mappers from the
 * registry. We reject the whole plan on any single failure so the user
 * cannot partially apply an invalid edit.
 */
const validateModifiedPlan = (
  operations: ToolApprovalOperation[],
): {
  operations: ToolApprovalOperation[];
  summary: ToolApprovalSummary;
} => {
  const validatedOps: ToolApprovalOperation[] = [];
  const summaryOps: ToolApprovalSummary["operations"] = [];

  for (const op of operations) {
    const resolved = getAction(op.action);
    if (resolved === undefined) {
      return throwHttpError(400, {
        code: ERROR_CODES.EXTERNAL_APP_INVALID_ACTION,
        message: `Unknown action in plan: ${op.action}`,
      });
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
 * Detect a `TOOL_APPROVAL_WRONG_STATUS` HTTPException raised by the
 * underlying status-transition services. Used by grant / modify-and-grant
 * handlers to recover from idempotent retries: when a user double-clicks
 * Approve or a network retry repeats the request, the second call hits
 * a non-pending row — we catch that, re-read the current state, and
 * fall through to `executeAndMutateForGrant` which is itself idempotent
 * (returns the cached result for already-consumed rows).
 *
 * Rejected rows still bubble up the 409 — those are a real conflict
 * (someone else rejected between the user opening the card and clicking).
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
    "Returns the approval with the summary pre-rendered in the team's language (`team_settings.lang`) for direct display, and the raw `operations` for the Modify form. The frontend hits this whenever a chatbot conversation renders an approval card — including reloads days after the approval was created.",
  tags: ["ExternalApps"],
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
  summary: "Approve a pending plan as-is",
  description:
    "Transitions `pending` → `granted`. The next chatbot turn re-runs the same code; the dispatcher matches the existing grant by `lookupHash` and executes the stored operations.",
  tags: ["ExternalApps"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: approvalResponseSchema } },
      description: "Plan granted",
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
  summary: "Approve a pending plan after editing one or more operations",
  description:
    "Validates each modified op against the provider manifest, rebuilds the structural summary, and transitions `pending` → `granted` with the new `operations`. The `lookup_hash` is intentionally NOT recomputed — the agent's identical re-run still matches the grant and the (modified) stored operations are what execute.",
  tags: ["ExternalApps"],
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
  summary: "Reject a pending plan with an optional feedback note",
  description:
    "Transitions `pending` → `rejected`. The frontend forwards `feedback` to the chatbot as a continuation message so the agent can adapt; rejected rows are skipped when matching future grant lookups, so the agent can submit a fresh plan with no leftover state.",
  tags: ["ExternalApps"],
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
      description: "Plan rejected",
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

// ---- Handlers --------------------------------------------------------

approvalsRoutes.openapi(getRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const row = await getApprovalForCaller(id, team.id, user.id);
  return c.json(await toDto(row, team.id), 200);
});

approvalsRoutes.openapi(grantRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  // 1. Status transition `pending → granted`. Tolerate WRONG_STATUS so
  //    that double-clicks / network retries land in the idempotent
  //    execution path below instead of a noisy 409 the user did
  //    nothing to cause.
  let approval: ToolApprovalRequest;
  try {
    approval = await grantApproval({ id, teamId: team.id, userId: user.id });
  } catch (err) {
    if (!isWrongStatusError(err)) throw err;
    approval = await getApprovalForCaller(id, team.id, user.id);
    if (approval.status === "rejected") throw err;
  }
  // 2. Execute the plan via Nango AND substitute the persisted python
  //    tool output. After this returns, the next chatbot turn will see
  //    the actual result in its history and won't re-call python.
  approval = await executeAndMutateForGrant({
    approval,
    teamId: team.id,
    userId: user.id,
  });
  return c.json(await toDto(approval, team.id), 200);
});

approvalsRoutes.openapi(modifyAndGrantRoute, async (c) => {
  const team = c.get("team");
  if (!team) return c.json(teamRequired(), 403);
  const user = c.get("user");
  if (!user) return c.json(forbidden("Authentication required"), 403);

  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { operations, summary } = validateModifiedPlan(body.operations);

  // Same idempotent recovery shape as `grantRoute`. On WRONG_STATUS the
  // already-stored operations win — the user's modifications are dropped
  // because the previous (successful) modify-and-grant call already
  // persisted its own set. Acceptable: this branch only fires on retry.
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
    approval = await getApprovalForCaller(id, team.id, user.id);
    if (approval.status === "rejected") throw err;
  }
  approval = await executeAndMutateForGrant({
    approval,
    teamId: team.id,
    userId: user.id,
  });
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
    approval = await getApprovalForCaller(id, team.id, user.id);
    // Idempotent reject retry: if already rejected, fall through to
    // mutate (which is itself idempotent). If status is granted /
    // executing / consumed, the user actually approved before — surface
    // the 409 so the frontend doesn't silently flip the UI.
    if (approval.status !== "rejected") throw err;
  }
  await mutateForReject(approval);
  return c.json(await toDto(approval, team.id), 200);
});

export { approvalsRoutes };
