import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { forbidden } from "@fretik/shared/lib/errors";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  organizationSandboxPolicyPatchSchema,
  organizationSandboxPolicyResponseSchema,
  SANDBOX_MAX_EXTRA_DOMAINS,
  type OrganizationSandboxPolicy,
  type OrganizationSandboxPolicyResponse,
} from "@fretik/shared/schemas/sandbox-policy";
import {
  detectBackendHost,
  SANDBOX_EGRESS_TIERS,
} from "@fretik/shared/services/e2b/egress-tiers";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import {
  getOrganizationSandboxPolicy,
  setOrganizationSandboxPolicy,
} from "@fretik/shared/services/organization/sandbox-policy";
import {
  deleteImages,
  uploadImage,
} from "@fretik/shared/services/uploads/upload-image";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Organization endpoints. Logo bytes are uploaded here (normalised + stored on
 * S3, public) and the URL is returned; the frontend persists it on the org
 * record via Better Auth `organization.update({ data: { logo } })`. Both logo
 * routes require the caller to be an owner/admin of the active organization.
 *
 * `/sandbox-policy` is the org's code-sandbox egress setting. Reading it is
 * open to any member — the page says what the sandbox may reach, which is
 * exactly what a non-admin asking "why did that fail?" needs — while writing
 * is admin-only.
 */
const organizationRoutes = new OpenAPIHono<HonoLoggedAppType>();
organizationRoutes.use("*", authMiddleware);

const fileSchema = z.custom<File>(
  (val) => val instanceof Blob,
  "Expected a file",
);

const uploadLogoRoute = createRoute({
  method: "post",
  path: "/logo",
  summary: "Upload the organization logo",
  tags: ["Organization"],
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: fileSchema.openapi({
              type: "string",
              format: "binary",
              description: "PNG, JPEG or WEBP image, max 5 MB",
            }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ url: z.string() }) },
      },
      description: "Logo uploaded",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteLogoRoute = createRoute({
  method: "delete",
  path: "/logo",
  summary: "Remove the organization logo files",
  tags: ["Organization"],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Logo removed",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getSandboxPolicyRoute = createRoute({
  method: "get",
  path: "/sandbox-policy",
  summary: "Read the organization's sandbox egress policy",
  tags: ["Organization"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: organizationSandboxPolicyResponseSchema,
        },
      },
      description: "The effective policy plus what it cannot change",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const patchSandboxPolicyRoute = createRoute({
  method: "patch",
  path: "/sandbox-policy",
  summary: "Update the organization's sandbox egress policy",
  tags: ["Organization"],
  request: {
    body: {
      content: {
        "application/json": { schema: organizationSandboxPolicyPatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: organizationSandboxPolicyResponseSchema,
        },
      },
      description: "The merged policy",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * The tiers an admin does NOT control travel with every response, so the page
 * can show what is reachable instead of asserting it in a sentence that drifts.
 * Provider hosts are deliberately absent: they follow the team's live
 * connections, and this is an ORG-level response.
 */
const sandboxPolicyResponse = (
  policy: OrganizationSandboxPolicy,
): OrganizationSandboxPolicyResponse => {
  const backendHost = detectBackendHost();
  return {
    policy,
    defaults: DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    limits: { maxDomains: SANDBOX_MAX_EXTRA_DOMAINS },
    alwaysAllowed: {
      platform: backendHost === null ? [] : [backendHost],
      packages: [...SANDBOX_EGRESS_TIERS.packages],
    },
  };
};

organizationRoutes.openapi(getSandboxPolicyRoute, async (c) => {
  const org = c.get("organization");
  const policy = await getOrganizationSandboxPolicy(org.id);
  return c.json(sandboxPolicyResponse(policy), 200);
});

organizationRoutes.openapi(patchSandboxPolicyRoute, async (c) => {
  const user = c.get("user");
  const org = c.get("organization");
  if (!(await isOrgAdmin(org.id, user.id))) return c.json(forbidden(), 403);

  const merged = await setOrganizationSandboxPolicy({
    organizationId: org.id,
    patch: c.req.valid("json"),
  });
  return c.json(sandboxPolicyResponse(merged), 200);
});

organizationRoutes.openapi(uploadLogoRoute, async (c) => {
  const user = c.get("user");
  const org = c.get("organization");
  if (!(await isOrgAdmin(org.id, user.id))) return c.json(forbidden(), 403);

  const { file } = c.req.valid("form");
  const url = await uploadImage({ prefix: "org-logos", id: org.id, file });
  return c.json({ url }, 200);
});

organizationRoutes.openapi(deleteLogoRoute, async (c) => {
  const user = c.get("user");
  const org = c.get("organization");
  if (!(await isOrgAdmin(org.id, user.id))) return c.json(forbidden(), 403);

  await deleteImages("org-logos", org.id);
  return c.json({ ok: true }, 200);
});

export { organizationRoutes };
