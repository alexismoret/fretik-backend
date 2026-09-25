import { access } from "@fretik/shared/authz/http";
import { buildRoleMatrix } from "@fretik/shared/authz/role-matrix";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  accessMeSchema,
  organizationPolicyResponseSchema,
  roleMatrixSchema,
  updateOrganizationPolicySchema,
} from "@fretik/shared/schemas/access-api";
import {
  accessJournalPageSchema,
  accessJournalQuerySchema,
} from "@fretik/shared/schemas/access-journal";
import { DEFAULT_ORGANIZATION_ACCESS_POLICY } from "@fretik/shared/schemas/access-policy";
import {
  accessRequestListSchema,
  accessRequestParamsSchema,
  accessRequestSchema,
  decideAccessRequestSchema,
  requestAccessSchema,
} from "@fretik/shared/schemas/access-requests";
import {
  guestInviteResultSchema,
  inviteGuestsSchema,
  resourceAccessParamsSchema,
  resourceAccessSchema,
  resourceGrantParamsSchema,
  setGeneralAccessSchema,
  setGrantLevelSchema,
  shareResourceSchema,
} from "@fretik/shared/schemas/access-sharing";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { sharedWithMeSchema } from "@fretik/shared/schemas/shared-with-me";
import { describeAccess } from "@fretik/shared/services/access/describe";
import { inviteGuests } from "@fretik/shared/services/access/guests/invite-guests";
import { listAccessJournal } from "@fretik/shared/services/access/journal/list-journal";
import {
  cancelAccessRequest,
  decideAccessRequest,
} from "@fretik/shared/services/access/requests/decide-request";
import { listAccessRequests } from "@fretik/shared/services/access/requests/list-requests";
import { requestAccess } from "@fretik/shared/services/access/requests/request-access";
import { changeGrantLevel } from "@fretik/shared/services/access/sharing/change-grant-level";
import { describeResourceAccess } from "@fretik/shared/services/access/sharing/describe";
import { listSharedWithMe } from "@fretik/shared/services/access/sharing/list-shared-with-me";
import { revokeGrant } from "@fretik/shared/services/access/sharing/revoke-grant";
import { setGeneralAccess } from "@fretik/shared/services/access/sharing/set-general-access";
import { shareResource } from "@fretik/shared/services/access/sharing/share";
import { updateOrganizationPolicy } from "@fretik/shared/services/access/update-organization-policy";
import { getOrganizationAccessPolicy } from "@fretik/shared/services/organization/access-policy";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/access` — the access engine, as the app reads it: who the caller is to
 * it, what the organization allows beyond the roles, the roles grid — and
 * who has access to one resource, which the share dialog reads and changes
 * (`/resources/{type}/{id}`), what others shared with the caller
 * (`/shared-with-me`), the requests for more access, asked from a
 * refusal and answered by whoever could share (`/requests`), and the journal
 * of every change to who may do what (`/journal`).
 *
 * The client decides nothing: it shows, hides or locks an action from the
 * decisions sent here, and a refusal it did not predict still arrives as a
 * 403 `ACCESS_DENIED` it can explain.
 */
const accessRoutes = new OpenAPIHono<HonoLoggedAppType>();
accessRoutes.use("*", authMiddleware);

const meRoute = createRoute({
  method: "get",
  path: "/me",
  middleware: access.session(
    "The caller's own standing and decisions, in their active team; nothing about anyone else.",
  ),
  summary: "The caller's roles and every capability decided for them",
  tags: ["Access"],
  responses: {
    200: {
      content: { "application/json": { schema: accessMeSchema } },
      description: "The caller, as the access engine sees them",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getPolicyRoute = createRoute({
  method: "get",
  path: "/policy",
  middleware: access.session(
    "The organization's own settings: what the product allows there, nothing about anyone's content.",
  ),
  summary: "What the organization allows beyond the roles",
  tags: ["Access"],
  responses: {
    200: {
      content: {
        "application/json": { schema: organizationPolicyResponseSchema },
      },
      description: "The policy, and each setting's default",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updatePolicyRoute = createRoute({
  method: "patch",
  path: "/policy",
  middleware: access.capability("policies.manage"),
  summary: "Change what the organization allows",
  description:
    "Sparse: only the settings sent change. Turning something off keeps what already exists and stops what comes next.",
  tags: ["Access"],
  request: {
    body: {
      content: {
        "application/json": { schema: updateOrganizationPolicySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: organizationPolicyResponseSchema },
      },
      description: "The policy, and each setting's default",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const rolesRoute = createRoute({
  method: "get",
  path: "/roles",
  middleware: access.session(
    "The roles grid under the organization's policy: what each role may do, true of everyone alike.",
  ),
  summary: "What each role may do, under the organization's policy",
  description:
    "Every capability decided for each standing (admin, lead, member, viewer, guest) by the same engine that decides requests.",
  tags: ["Access"],
  responses: {
    200: {
      content: { "application/json": { schema: roleMatrixSchema } },
      description: "The roles grid",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const journalRoute = createRoute({
  method: "get",
  path: "/journal",
  middleware: access.capability("audit.read"),
  summary: "The access journal",
  description:
    "Every change to who may do what, newest first, a page at a time, by kind of change or by person. An item is named only to a reader who can open it now.",
  tags: ["Access"],
  request: { query: accessJournalQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: accessJournalPageSchema } },
      description: "A page of the journal",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// --- One resource: the share dialog -----------------------------------------

const SHARING_RULE =
  "The service decides on the resource the path names: view to read who has access, full to change it (never a guest), and the organization's policy for a new share beyond the team or with everyone.";

const resourceAccessResponses = {
  200: {
    content: { "application/json": { schema: resourceAccessSchema } },
    description: "Who has access to the resource, and the caller's own level",
  },
  ...responseBadRequestSchema,
  ...responseForbiddenSchema,
  ...responseNotFoundSchema,
  ...responseInternalErrorSchema,
};

const getResourceAccessRoute = createRoute({
  method: "get",
  path: "/resources/{type}/{id}",
  middleware: access.handler(SHARING_RULE),
  summary: "Who has access to a resource",
  description:
    "Its owner, the people and groups it is shared with, and what it inherits from while it is not restricted.",
  tags: ["Access"],
  request: { params: resourceAccessParamsSchema },
  responses: resourceAccessResponses,
});

const shareResourceRoute = createRoute({
  method: "post",
  path: "/resources/{type}/{id}/grants",
  middleware: access.handler(SHARING_RULE),
  summary: "Share a resource with people, teams or the organization",
  description:
    "At one level. A pick that already has access gets the new level; the owner is skipped, having full access already.",
  tags: ["Access"],
  request: {
    params: resourceAccessParamsSchema,
    body: {
      content: { "application/json": { schema: shareResourceSchema } },
      required: true,
    },
  },
  responses: resourceAccessResponses,
});

const inviteByEmailRoute = createRoute({
  method: "post",
  path: "/resources/{type}/{id}/invitations",
  middleware: access.handler(
    "The service decides on the resource the path names: full access, never a guest; the organization's policy for each new share, and guests.invite in the resource's team for anyone invited as a guest.",
  ),
  summary: "Share a resource with people by email",
  description:
    "Someone of the organization is given access at once; an address with an invitation on its way gets this item added to it; anyone else is invited as a guest and reaches the item once they accept. One outcome per address.",
  tags: ["Access"],
  request: {
    params: resourceAccessParamsSchema,
    body: {
      content: { "application/json": { schema: inviteGuestsSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: guestInviteResultSchema } },
      description: "What became of each address, and the dialog's new model",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const changeGrantRoute = createRoute({
  method: "patch",
  path: "/resources/{type}/{id}/grants/{principalType}/{principalId}",
  middleware: access.handler(SHARING_RULE),
  summary: "Change the level someone has on a resource",
  tags: ["Access"],
  request: {
    params: resourceGrantParamsSchema,
    body: {
      content: { "application/json": { schema: setGrantLevelSchema } },
      required: true,
    },
  },
  responses: { ...resourceAccessResponses, ...responseConflictSchema },
});

const revokeGrantRoute = createRoute({
  method: "delete",
  path: "/resources/{type}/{id}/grants/{principalType}/{principalId}",
  middleware: access.handler(SHARING_RULE),
  summary: "Take someone's access to a resource away",
  description:
    "204 when the caller took their own access away and can no longer see the resource.",
  tags: ["Access"],
  request: { params: resourceGrantParamsSchema },
  responses: {
    ...resourceAccessResponses,
    ...responseConflictSchema,
    204: { description: "The caller no longer has access" },
  },
});

const setGeneralAccessRoute = createRoute({
  method: "patch",
  path: "/resources/{type}/{id}",
  middleware: access.handler(SHARING_RULE),
  summary: "Restrict a resource, or open it to what it inherits from",
  description:
    "Restricted, only its owner and the people and groups it is shared with reach it. Only its owner restricts a workflow.",
  tags: ["Access"],
  request: {
    params: resourceAccessParamsSchema,
    body: {
      content: { "application/json": { schema: setGeneralAccessSchema } },
      required: true,
    },
  },
  responses: resourceAccessResponses,
});

const sharedWithMeRoute = createRoute({
  method: "get",
  path: "/shared-with-me",
  middleware: access.session(
    "What others shared with the caller, each item decided by the engine for them; nothing of anyone else's shares.",
  ),
  summary: "What others have shared with the caller",
  description:
    "Shared with them by name, or with a team, a project or the organization from a team they are not in. Newest first.",
  tags: ["Access"],
  responses: {
    200: {
      content: { "application/json": { schema: sharedWithMeSchema } },
      description: "The items shared with the caller",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// --- Requests for more access -----------------------------------------------

const accessRequestResponses = {
  200: {
    content: { "application/json": { schema: accessRequestSchema } },
    description: "The request, as it now stands",
  },
  ...responseBadRequestSchema,
  ...responseForbiddenSchema,
  ...responseNotFoundSchema,
  ...responseInternalErrorSchema,
};

const requestAccessRoute = createRoute({
  method: "post",
  path: "/resources/{type}/{id}/requests",
  middleware: access.handler(
    "The service decides on the resource the path names: only one the caller can see is asked for (one they cannot answers 404 like any other), never by a guest, and only for more than they have.",
  ),
  summary: "Ask for more access to a resource",
  description:
    "The people who hold full access to it are emailed. Asking again while the request waits updates it.",
  tags: ["Access"],
  request: {
    params: resourceAccessParamsSchema,
    body: {
      content: { "application/json": { schema: requestAccessSchema } },
      required: true,
    },
  },
  responses: accessRequestResponses,
});

const listRequestsRoute = createRoute({
  method: "get",
  path: "/requests",
  middleware: access.handler(
    "The caller's own pending requests, and the pending ones on resources the engine finds they hold full access to; nothing else.",
  ),
  summary: "The requests waiting on the caller, and their own",
  tags: ["Access"],
  responses: {
    200: {
      content: { "application/json": { schema: accessRequestListSchema } },
      description: "Pending requests to answer, and the caller's own",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const decideRequestRoute = createRoute({
  method: "post",
  path: "/requests/{requestId}/decision",
  middleware: access.handler(
    "The service loads the request in the caller's organization and decides on its resource as the share dialog does: full access, never a guest. Approving is sharing, with the same policy checks.",
  ),
  summary: "Approve or deny a request for access",
  description:
    "Approving shares the resource at the level asked for, or the one sent. The requester is emailed the answer.",
  tags: ["Access"],
  request: {
    params: accessRequestParamsSchema,
    body: {
      content: { "application/json": { schema: decideAccessRequestSchema } },
      required: true,
    },
  },
  responses: { ...accessRequestResponses, ...responseConflictSchema },
});

const cancelRequestRoute = createRoute({
  method: "delete",
  path: "/requests/{requestId}",
  middleware: access.handler(
    "Only the requester's own pending request: anyone else's, or one already answered, reads as missing.",
  ),
  summary: "Withdraw one's own request for access",
  tags: ["Access"],
  request: { params: accessRequestParamsSchema },
  responses: {
    204: { description: "The request is withdrawn" },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

accessRoutes.openapi(meRoute, async (c) => {
  const me = await describeAccess({
    principal: c.get("principal"),
    activeTeamId: c.get("team")?.id ?? null,
  });
  return c.json(me, 200);
});

accessRoutes.openapi(getPolicyRoute, async (c) => {
  const policy = await getOrganizationAccessPolicy(
    c.get("principal").organizationId,
  );
  return c.json({ policy, defaults: DEFAULT_ORGANIZATION_ACCESS_POLICY }, 200);
});

accessRoutes.openapi(updatePolicyRoute, async (c) => {
  const policy = await updateOrganizationPolicy({
    principal: c.get("principal"),
    patch: c.req.valid("json"),
  });
  return c.json({ policy, defaults: DEFAULT_ORGANIZATION_ACCESS_POLICY }, 200);
});

accessRoutes.openapi(rolesRoute, async (c) => {
  const policy = await getOrganizationAccessPolicy(
    c.get("principal").organizationId,
  );
  return c.json({ rows: buildRoleMatrix(policy) }, 200);
});

accessRoutes.openapi(journalRoute, async (c) => {
  const page = await listAccessJournal({
    principal: c.get("principal"),
    query: c.req.valid("query"),
  });
  return c.json(page, 200);
});

accessRoutes.openapi(getResourceAccessRoute, async (c) => {
  const { type, id } = c.req.valid("param");
  const model = await describeResourceAccess({
    principal: c.get("principal"),
    type,
    id,
  });
  return c.json(model, 200);
});

accessRoutes.openapi(shareResourceRoute, async (c) => {
  const { type, id } = c.req.valid("param");
  const { principals, level } = c.req.valid("json");
  const model = await shareResource({
    principal: c.get("principal"),
    type,
    id,
    principals,
    level,
  });
  return c.json(model, 200);
});

accessRoutes.openapi(inviteByEmailRoute, async (c) => {
  const { type, id } = c.req.valid("param");
  const { emails, level } = c.req.valid("json");
  const result = await inviteGuests({
    principal: c.get("principal"),
    type,
    id,
    emails,
    level,
  });
  return c.json(result, 200);
});

accessRoutes.openapi(changeGrantRoute, async (c) => {
  const { type, id, principalType, principalId } = c.req.valid("param");
  const model = await changeGrantLevel({
    principal: c.get("principal"),
    type,
    id,
    holder: { type: principalType, id: principalId },
    level: c.req.valid("json").level,
  });
  return c.json(model, 200);
});

accessRoutes.openapi(revokeGrantRoute, async (c) => {
  const { type, id, principalType, principalId } = c.req.valid("param");
  const model = await revokeGrant({
    principal: c.get("principal"),
    type,
    id,
    holder: { type: principalType, id: principalId },
  });
  if (model === null) return c.body(null, 204);
  return c.json(model, 200);
});

accessRoutes.openapi(setGeneralAccessRoute, async (c) => {
  const { type, id } = c.req.valid("param");
  const model = await setGeneralAccess({
    principal: c.get("principal"),
    type,
    id,
    restricted: c.req.valid("json").restricted,
  });
  return c.json(model, 200);
});

accessRoutes.openapi(sharedWithMeRoute, async (c) => {
  const shared = await listSharedWithMe(c.get("principal"));
  return c.json(shared, 200);
});

accessRoutes.openapi(requestAccessRoute, async (c) => {
  const { type, id } = c.req.valid("param");
  const { level, message } = c.req.valid("json");
  const request = await requestAccess({
    principal: c.get("principal"),
    type,
    id,
    level,
    message,
  });
  return c.json(request, 200);
});

accessRoutes.openapi(listRequestsRoute, async (c) => {
  const requests = await listAccessRequests(c.get("principal"));
  return c.json(requests, 200);
});

accessRoutes.openapi(decideRequestRoute, async (c) => {
  const { decision, level } = c.req.valid("json");
  const request = await decideAccessRequest({
    principal: c.get("principal"),
    requestId: c.req.valid("param").requestId,
    decision,
    level,
  });
  return c.json(request, 200);
});

accessRoutes.openapi(cancelRequestRoute, async (c) => {
  await cancelAccessRequest({
    principal: c.get("principal"),
    requestId: c.req.valid("param").requestId,
  });
  return c.body(null, 204);
});

export { accessRoutes };
