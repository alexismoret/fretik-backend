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
import { DEFAULT_ORGANIZATION_ACCESS_POLICY } from "@fretik/shared/schemas/access-policy";
import {
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
import { describeAccess } from "@fretik/shared/services/access/describe";
import { changeGrantLevel } from "@fretik/shared/services/access/sharing/change-grant-level";
import { describeResourceAccess } from "@fretik/shared/services/access/sharing/describe";
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
 * (`/resources/{type}/{id}`).
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

export { accessRoutes };
