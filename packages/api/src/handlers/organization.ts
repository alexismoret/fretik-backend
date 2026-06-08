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
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import {
  deleteImages,
  uploadImage,
} from "@fretik/shared/services/uploads/upload-image";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Organization endpoints. Logo bytes are uploaded here (normalised + stored on
 * S3, public) and the URL is returned; the frontend persists it on the org
 * record via Better Auth `organization.update({ data: { logo } })`. Both routes
 * require the caller to be an owner/admin of the active organization.
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
