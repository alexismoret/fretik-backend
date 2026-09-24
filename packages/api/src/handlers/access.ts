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
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import { describeAccess } from "@fretik/shared/services/access/describe";
import { updateOrganizationPolicy } from "@fretik/shared/services/access/update-organization-policy";
import { getOrganizationAccessPolicy } from "@fretik/shared/services/organization/access-policy";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * `/access` — the access engine, as the app reads it: who the caller is to
 * it, what the organization allows beyond the roles, and the roles grid.
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

export { accessRoutes };
