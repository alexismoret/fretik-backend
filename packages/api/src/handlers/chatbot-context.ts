import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { forbidden, notFound, throwHttpError } from "@fretik/shared/lib/errors";
import { getPresignedUrl } from "@fretik/shared/lib/s3";
import {
  contextFileContentResponseSchema,
  contextFileDownloadResponseSchema,
  contextFileSummarySchema,
  contextOkResponseSchema,
  contextProfileIdResponseSchema,
  contextProfileResponseSchema,
  muteContextResourceSchema,
  scopeAndFileIdParamSchema,
  scopeParamSchema,
  toggleContextFileEnabledSchema,
  updateContextInstructionsSchema,
  uploadContextFileSchema,
} from "@fretik/shared/schemas/ai-context";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessSchemaBuilder,
} from "@fretik/shared/schemas/common/responses";
import { deleteContextFile } from "@fretik/shared/services/ai-context/delete";
import {
  setUserFileMute,
  setUserProfileMute,
} from "@fretik/shared/services/ai-context/mutes";
import {
  getContextFileContent,
  getContextProfile,
  type ScopeKey,
} from "@fretik/shared/services/ai-context/retrieve";
import {
  setContextFileEnabled,
  upsertContextInstructions,
} from "@fretik/shared/services/ai-context/update";
import { uploadContextFile } from "@fretik/shared/services/ai-context/upload";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const chatbotContextRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatbotContextRoutes.use("*", authMiddleware);

// ==================== //
// HELPERS              //
// ==================== //

/**
 * Translate the Hono session (populated by `authMiddleware`) into the
 * ScopeKey shape the shared services expect. Team scope requires an
 * active team on the session — we fail fast instead of silently
 * routing to a null profile.
 */
const buildScopeKey = (
  c: Context<HonoLoggedAppType>,
  scope: "user" | "team",
): ScopeKey => {
  const user = c.get("user");
  const organization = c.get("organization");
  const team = c.get("team");

  if (scope === "team" && !team) {
    return throwHttpError(403, forbidden("No active team in session"));
  }

  return {
    scope,
    userId: user.id,
    teamId: scope === "team" ? (team?.id ?? null) : null,
    organizationId: organization.id,
  };
};

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const getProfileRoute = createRoute({
  method: "get",
  path: "/{scope}",
  summary: "Get the chatbot context profile for a scope",
  description:
    "Returns the current user or team context profile (instructions + files). The profile is lazily created on first write; an empty shell is returned when nothing has been saved yet.",
  tags: ["ChatbotContext"],
  request: { params: scopeParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(contextProfileResponseSchema, "Profile"),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateInstructionsRoute = createRoute({
  method: "patch",
  path: "/{scope}",
  summary: "Upsert the context instructions for a scope",
  tags: ["ChatbotContext"],
  request: {
    params: scopeParamSchema,
    body: {
      content: {
        "application/json": { schema: updateContextInstructionsSchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(
      contextProfileIdResponseSchema,
      "Instructions saved",
    ),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const uploadFileRoute = createRoute({
  method: "post",
  path: "/{scope}/files",
  summary: "Upload a context file",
  description:
    "Uploads a single file into the scope's context profile. Max 15 MB. Supported types: PDF, DOCX, PPTX, XLSX, XLS, CSV, TXT, MD, JSON, PNG, JPEG, WebP.",
  tags: ["ChatbotContext"],
  request: {
    params: scopeParamSchema,
    body: {
      content: {
        "multipart/form-data": { schema: uploadContextFileSchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(contextFileSummarySchema, "File accepted"),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const toggleEnabledRoute = createRoute({
  method: "patch",
  path: "/{scope}/files/{fileId}/enabled",
  summary: "Toggle the `enabled` flag on a context file",
  description:
    "At team scope any team member can flip this and the change applies to everybody. At user scope it is personal to the owner. Per-user overrides on team files live on `/mute`.",
  tags: ["ChatbotContext"],
  request: {
    params: scopeAndFileIdParamSchema,
    body: {
      content: {
        "application/json": { schema: toggleContextFileEnabledSchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(contextOkResponseSchema, "Toggled"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const muteFileRoute = createRoute({
  method: "patch",
  path: "/{scope}/files/{fileId}/mute",
  summary: "Per-user mute override on a team-scope context file",
  description:
    "Lets a user disable a team-scope file for themselves only, without affecting other team members. Rejected for user-scope files.",
  tags: ["ChatbotContext"],
  request: {
    params: scopeAndFileIdParamSchema,
    body: {
      content: { "application/json": { schema: muteContextResourceSchema } },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(contextOkResponseSchema, "Mute state set"),
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const muteProfileRoute = createRoute({
  method: "patch",
  path: "/{scope}/mute",
  summary: "Per-user mute override on team instructions",
  description:
    "Lets a user opt out of the team's instructions for themselves only. Only valid on team scope.",
  tags: ["ChatbotContext"],
  request: {
    params: scopeParamSchema,
    body: {
      content: { "application/json": { schema: muteContextResourceSchema } },
      required: true,
    },
  },
  responses: {
    ...responseSuccessSchemaBuilder(contextOkResponseSchema, "Mute state set"),
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getFileContentRoute = createRoute({
  method: "get",
  path: "/{scope}/files/{fileId}/content",
  summary: "Preview the extracted content of a context file",
  tags: ["ChatbotContext"],
  request: { params: scopeAndFileIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(
      contextFileContentResponseSchema,
      "Content",
    ),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const downloadFileRoute = createRoute({
  method: "get",
  path: "/{scope}/files/{fileId}/download",
  summary: "Get a presigned S3 URL to download the original file",
  tags: ["ChatbotContext"],
  request: { params: scopeAndFileIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(
      contextFileDownloadResponseSchema,
      "Presigned URL",
    ),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteFileRoute = createRoute({
  method: "delete",
  path: "/{scope}/files/{fileId}",
  summary: "Delete a context file",
  tags: ["ChatbotContext"],
  request: { params: scopeAndFileIdParamSchema },
  responses: {
    ...responseSuccessSchemaBuilder(contextOkResponseSchema, "Deleted"),
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// IMPLEMENTATIONS      //
// ==================== //

chatbotContextRoutes.openapi(getProfileRoute, async (c) => {
  const { scope } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  const response = await getContextProfile(key);
  return c.json(response, 200);
});

chatbotContextRoutes.openapi(updateInstructionsRoute, async (c) => {
  const { scope } = c.req.valid("param");
  const body = c.req.valid("json");
  const key = buildScopeKey(c, scope);
  const profile = await upsertContextInstructions({
    scope: key,
    instructions: body.instructions,
  });
  return c.json({ id: profile.id }, 200);
});

chatbotContextRoutes.openapi(uploadFileRoute, async (c) => {
  const { scope } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  const user = c.get("user");
  const body = c.req.valid("form");
  const uploaded = await uploadContextFile({
    file: body.file,
    scope: key,
    uploadedById: user.id,
  });
  return c.json(
    {
      id: uploaded.id,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      status: uploaded.status,
      errorMessage: uploaded.errorMessage,
      charCount: uploaded.charCount,
      pageCount: uploaded.pageCount,
      enabled: uploaded.enabled,
      mutedByMe: false,
      uploadedById: uploaded.uploadedById,
      createdAt: uploaded.createdAt,
      updatedAt: uploaded.updatedAt,
    },
    200,
  );
});

chatbotContextRoutes.openapi(toggleEnabledRoute, async (c) => {
  const { scope, fileId } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  const body = c.req.valid("json");
  await setContextFileEnabled({
    fileId,
    organizationId: key.organizationId,
    enabled: body.enabled,
  });
  return c.json({ ok: true as const }, 200);
});

chatbotContextRoutes.openapi(muteFileRoute, async (c) => {
  const { scope, fileId } = c.req.valid("param");
  if (scope !== "team") {
    return throwHttpError(400, {
      code: "MUTE_NOT_ALLOWED",
      message: "Personal mutes are only available on team scope.",
    });
  }
  const key = buildScopeKey(c, scope);
  const body = c.req.valid("json");
  await setUserFileMute({
    userId: key.userId,
    fileId,
    organizationId: key.organizationId,
    muted: body.muted,
  });
  return c.json({ ok: true as const }, 200);
});

chatbotContextRoutes.openapi(muteProfileRoute, async (c) => {
  const { scope } = c.req.valid("param");
  if (scope !== "team") {
    return throwHttpError(400, {
      code: "MUTE_NOT_ALLOWED",
      message: "Personal instruction mutes are only available on team scope.",
    });
  }
  const key = buildScopeKey(c, scope);
  const body = c.req.valid("json");
  const { profile } = await getContextProfile(key);
  if (!profile.id) {
    return throwHttpError(404, notFound("No team context profile to mute"));
  }
  await setUserProfileMute({
    userId: key.userId,
    profileId: profile.id,
    organizationId: key.organizationId,
    muted: body.muted,
  });
  return c.json({ ok: true as const }, 200);
});

chatbotContextRoutes.openapi(getFileContentRoute, async (c) => {
  const { scope, fileId } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  const { file, content } = await getContextFileContent({
    fileId,
    organizationId: key.organizationId,
  });
  return c.json(
    {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      content,
    },
    200,
  );
});

chatbotContextRoutes.openapi(downloadFileRoute, async (c) => {
  const { scope, fileId } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  const { file } = await getContextFileContent({
    fileId,
    organizationId: key.organizationId,
  });
  // Signed as an attachment: the caller's only use for this URL is to save the
  // file, and the disposition is also what identifies it as a download to the
  // Electron shell, which otherwise hands it to a system browser.
  const url = await getPresignedUrl(file.s3Key, 60 * 5, {
    downloadFilename: file.filename,
  });
  return c.json({ url }, 200);
});

chatbotContextRoutes.openapi(deleteFileRoute, async (c) => {
  const { scope, fileId } = c.req.valid("param");
  const key = buildScopeKey(c, scope);
  await deleteContextFile({
    fileId,
    organizationId: key.organizationId,
  });
  return c.json({ ok: true as const }, 200);
});

export { chatbotContextRoutes };
