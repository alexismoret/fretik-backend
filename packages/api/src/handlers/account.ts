import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  deleteImages,
  uploadImage,
} from "@fretik/shared/services/uploads/upload-image";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Account endpoints. Avatar bytes are uploaded here (normalised + stored on
 * S3, public) and the URL is returned; the frontend then persists it on the
 * Better Auth user record via `updateUser({ image })` so the session updates
 * reactively.
 */
const accountRoutes = new OpenAPIHono<HonoLoggedAppType>();
accountRoutes.use("*", authMiddleware);

const fileSchema = z.custom<File>(
  (val) => val instanceof Blob,
  "Expected a file",
);

const uploadAvatarRoute = createRoute({
  method: "post",
  path: "/avatar",
  summary: "Upload the current user's avatar",
  tags: ["Account"],
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
      description: "Avatar uploaded",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteAvatarRoute = createRoute({
  method: "delete",
  path: "/avatar",
  summary: "Remove the current user's avatar files",
  tags: ["Account"],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Avatar removed",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

accountRoutes.openapi(uploadAvatarRoute, async (c) => {
  const user = c.get("user");
  const { file } = c.req.valid("form");
  const url = await uploadImage({ prefix: "avatars", id: user.id, file });
  return c.json({ url }, 200);
});

accountRoutes.openapi(deleteAvatarRoute, async (c) => {
  const user = c.get("user");
  await deleteImages("avatars", user.id);
  return c.json({ ok: true }, 200);
});

export { accountRoutes };
