import {
  authMiddleware,
  type HonoLoggedAppType,
  superAdminMiddleware,
} from "@fretik/shared/lib/auth-middleware";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  countSuperAdmins,
  grantSuperAdmin,
  listSuperAdmins,
  revokeSuperAdmin,
} from "@fretik/shared/services/auth/super-admins";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Super-admin management (platform operators). Super-admin only —
 * `authMiddleware` authenticates, `superAdminMiddleware` enforces the operator
 * flag. Grant promotes an existing account by email; revoke clears the flag,
 * but the caller can neither revoke themselves nor remove the last super-admin
 * (both would risk locking everyone out of the admin pages).
 */
const superAdminRoutes = new OpenAPIHono<HonoLoggedAppType>();
superAdminRoutes.use("*", authMiddleware);
superAdminRoutes.use("*", superAdminMiddleware);

const superAdminSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  createdAt: z.date(),
});

const listRoute = createRoute({
  method: "get",
  path: "",
  summary: "List super-admins",
  tags: ["Super admins"],
  responses: {
    200: {
      content: { "application/json": { schema: z.array(superAdminSchema) } },
      description: "Super-admins",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const grantRoute = createRoute({
  method: "post",
  path: "",
  summary: "Grant super-admin to an existing account by email",
  tags: ["Super admins"],
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ email: z.email() }) },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: superAdminSchema } },
      description: "Super-admin granted",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "",
  summary: "Revoke super-admin from a user",
  tags: ["Super admins"],
  request: { query: z.object({ userId: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Super-admin revoked",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

superAdminRoutes.openapi(listRoute, async (c) =>
  c.json(await listSuperAdmins(), 200),
);

superAdminRoutes.openapi(grantRoute, async (c) => {
  const { email } = c.req.valid("json");
  const granted = await grantSuperAdmin(email);
  if (!granted) {
    return c.json(
      {
        message: "No account exists for this email. Ask them to sign up first.",
        code: "USER_NOT_FOUND",
      },
      400,
    );
  }
  return c.json(granted, 200);
});

superAdminRoutes.openapi(revokeRoute, async (c) => {
  const { userId } = c.req.valid("query");
  // Guard against locking everyone out of the admin pages.
  if (userId === c.get("user").id) {
    return c.json(
      {
        message: "You cannot revoke your own super-admin.",
        code: "BAD_REQUEST",
      },
      400,
    );
  }
  if ((await countSuperAdmins()) <= 1) {
    return c.json(
      { message: "Cannot revoke the last super-admin.", code: "BAD_REQUEST" },
      400,
    );
  }
  await revokeSuperAdmin(userId);
  return c.json({ ok: true }, 200);
});

export { superAdminRoutes };
