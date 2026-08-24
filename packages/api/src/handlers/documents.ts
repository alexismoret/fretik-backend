import type { Document, DocumentVersion } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { applyAntiBufferingHeaders } from "@fretik/shared/lib/sse-headers";
import {
  AuthoredContentResponseSchema,
  bodyIdListSchema,
  CreateAuthoredDocumentSchema,
  DocumentResponseSchema,
  DocumentVersionDownloadSchema,
  DocumentVersionSchema,
  GetDocumentDetailsResponseSchema,
  RecentDocumentSchema,
  SaveAuthoredContentResponseSchema,
  SaveAuthoredContentSchema,
  UpdateDocumentSchema,
  UploadDocumentSchema,
  UploadOutcomeSchema,
} from "@fretik/shared/schemas";
import {
  paramsIdSchema,
  paramsListSchema,
} from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseCreatedSchemaBuilder,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseListSchema,
  responseNotFoundSchema,
  responseSuccessDeletedSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  getAuthoredContent,
  saveAuthoredContent,
} from "@fretik/shared/services/documents/authored/content";
import { createAuthoredDocument } from "@fretik/shared/services/documents/authored/create";
import { deleteDocuments } from "@fretik/shared/services/documents/delete";
import { listRecentDocuments } from "@fretik/shared/services/documents/list-recent";
import { streamUploadProgress } from "@fretik/shared/services/documents/progress";
import { reextractDocument } from "@fretik/shared/services/documents/reextract";
import {
  getDocumentBreadcrumbs,
  getDocumentDetails,
} from "@fretik/shared/services/documents/retrieve";
import { updateDocument } from "@fretik/shared/services/documents/update";
import { uploadDocument } from "@fretik/shared/services/documents/upload";
import { getDocumentVersionDownloadUrl } from "@fretik/shared/services/documents/versions/download";
import { listDocumentVersions } from "@fretik/shared/services/documents/versions/list";
import { restoreDocumentVersion } from "@fretik/shared/services/documents/versions/restore";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const documentRoutes = new OpenAPIHono<HonoLoggedAppType>();
documentRoutes.use("*", authMiddleware);

// ==================== //
// HELPERS              //
// ==================== //

const formatDocumentResponse = (doc: Document) => ({
  id: doc.id,
  teamId: doc.teamId,
  folderId: doc.folderId,
  status: doc.status,
  source: doc.source,
  errorMessage: doc.errorMessage,
  originalFilename: doc.originalFilename,
  fileSize: doc.fileSize,
  mimeType: doc.mimeType,
  uploadedById: doc.uploadedById,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

/** Version rows without their storage key — an S3 key is never client-facing. */
const formatVersionResponse = (version: DocumentVersion) => ({
  id: version.id,
  versionNumber: version.versionNumber,
  operation: version.operation,
  fileSize: version.fileSize,
  byActor: version.byActor,
  byUserId: version.byUserId,
  byConversationId: version.byConversationId,
  createdAt: version.createdAt,
});

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const uploadDocumentRoute = createRoute({
  method: "post",
  path: "/upload",
  summary: "Upload a document",
  description:
    "Uploads a single file, saves it to DB with 'uploading' status, and starts background processing (S3, thumbnail, pre-extraction).",
  tags: ["Documents"],
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: UploadDocumentSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    ...responseCreatedSchemaBuilder(
      DocumentResponseSchema.extend({ outcome: UploadOutcomeSchema }),
      "Document created, replaced, or already present",
    ),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const listRecentDocumentsRoute = createRoute({
  method: "get",
  path: "",
  summary: "List recent documents",
  description:
    "The team's most recently added documents, newest first — a lightweight projection (name, kind, size, status, when) for the home dashboard. Paginated with an exact total.",
  tags: ["Documents"],
  request: { query: paramsListSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: responseListSchema(RecentDocumentSchema),
        },
      },
      description: "Recent documents retrieved",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateDocumentRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a document",
  description: "Update a specific document by ID",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": {
          schema: UpdateDocumentSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: DocumentResponseSchema,
        },
      },
      description: "Document updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteDocumentsRoute = createRoute({
  method: "delete",
  path: "",
  summary: "Delete multiple documents",
  description: "Delete multiple documents by ID",
  tags: ["Documents"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: bodyIdListSchema,
        },
      },
    },
  },
  responses: {
    ...responseSuccessDeletedSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * -- GET DOCUMENT DETAILS
 * --
 */
const getDocumentDetailsRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get document details",
  description:
    "Retrieves detailed information about a document, including properties and a presigned file URL",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GetDocumentDetailsResponseSchema,
        },
      },
      description: "Document details retrieved successfully",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const reextractDocumentRoute = createRoute({
  method: "post",
  path: "/{id}/reextract",
  summary: "Re-extract a document",
  description:
    "Re-runs classification and entity extraction against the team's current field definitions (OCR is reused from cache). The document returns to `processing`; progress streams over the existing upload SSE.",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Re-extraction enqueued",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

/**
 * -- AUTHORING + VERSIONS
 * --
 * Authoring writes a document instead of uploading one; versions apply to
 * EVERY document, not just written ones — one history, one restore, whatever
 * the file type.
 */
const createAuthoredDocumentRoute = createRoute({
  method: "post",
  path: "/authored",
  summary: "Create a written document",
  description:
    "Creates a markdown document authored in Fretik. Unlike an upload it is `ready` immediately — nothing to convert or OCR — and is mirrored into the graph and indexed for search like any other document.",
  tags: ["Documents"],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateAuthoredDocumentSchema },
      },
      required: true,
    },
  },
  responses: {
    ...responseCreatedSchemaBuilder(DocumentResponseSchema, "Document created"),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getDocumentContentRoute = createRoute({
  method: "get",
  path: "/{id}/content",
  summary: "Read a written document's text",
  description:
    "Returns the markdown of a document authored in Fretik. Uploaded files are not text and are read through their presigned URL instead.",
  tags: ["Documents"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: AuthoredContentResponseSchema },
      },
      description: "Content retrieved",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// PATCH, not PUT: every other update route in this API is PATCH, and the body
// is not a complete representation of the resource — `baseUpdatedAt` is an
// optimistic-concurrency token, not part of the content.
const saveDocumentContentRoute = createRoute({
  method: "patch",
  path: "/{id}/content",
  summary: "Save a written document's text",
  description:
    "Replaces the markdown and records a version. Consecutive saves by the same author within a few minutes fold into one version. Send `baseUpdatedAt` to be refused with 409 rather than overwrite a concurrent save.",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: SaveAuthoredContentSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: SaveAuthoredContentResponseSchema },
      },
      description: "Content saved",
    },
    409: {
      content: {
        "application/json": {
          schema: z.object({
            code: z.enum(["DOCUMENT_STALE"]),
            message: z.string().optional(),
          }),
        },
      },
      description:
        "The document changed since it was loaded — reload before saving",
    },
    ...responseBadRequestSchema,
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const listDocumentVersionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  summary: "List a document's versions",
  description:
    "History of a document, newest first, with who produced each version. Available for every document — a written one, an uploaded file that was replaced, or one that was never touched (which has a single version).",
  tags: ["Documents"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(DocumentVersionSchema) },
      },
      description: "Versions retrieved",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const restoreDocumentVersionRoute = createRoute({
  method: "post",
  path: "/{id}/versions/{versionId}/restore",
  summary: "Restore a document version",
  description:
    "Brings back a previous version's content. The rollback becomes the newest version rather than truncating history, so it can itself be undone. Files that carry derived data (thumbnail, extracted fields) are re-processed against the restored bytes.",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema.extend({ versionId: z.uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: SaveAuthoredContentResponseSchema },
      },
      description: "Version restored",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const downloadDocumentVersionRoute = createRoute({
  method: "get",
  path: "/{id}/versions/{versionId}/download",
  summary: "Download one version",
  description:
    "A short-lived link to a past version's bytes. Reading an old version must not move the document, so this is what the history offers instead of restoring: the file downloads under a name carrying its version number.",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema.extend({ versionId: z.uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: DocumentVersionDownloadSchema },
      },
      description: "Signed download url",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// ROUTE HANDLERS       //
// ==================== //

/**
 * -- UPLOAD DOCUMENT
 * --
 */
documentRoutes.openapi(uploadDocumentRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const organization = c.get("organization");

  if (!team) {
    return c.json(teamRequired(), 403);
  }

  const { file, folderId, onConflict } = c.req.valid("form");

  const result = await uploadDocument(
    file,
    organization.id,
    team.id,
    user.id,
    folderId,
    onConflict,
  );

  // `outcome` rides on the document rather than wrapping it: every existing
  // caller reads `id` / `status` off the top level, and a same-name upload that
  // landed as a new version is still, to them, "the document you just sent".
  return c.json(
    { ...formatDocumentResponse(result.document), outcome: result.outcome },
    201,
  );
});

/**
 * -- UPLOAD PROGRESS
 * --
 * SSE endpoint for real-time document processing progress.
 */
documentRoutes.get("/upload/:documentId/progress", async (c) => {
  const { documentId } = c.req.param();

  applyAntiBufferingHeaders(c);
  return streamSSE(c, async (stream) => {
    await streamUploadProgress(documentId, stream);
  });
});

/**
 * -- DELETE DOCUMENTS
 * --
 */
documentRoutes.openapi(deleteDocumentsRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { ids } = c.req.valid("json");

  const res = await deleteDocuments({ ids, teamId: team.id });

  return c.json({ rowCount: res.rowCount }, 200);
});

/**
 * -- UPDATE DOCUMENT
 * --
 */
documentRoutes.openapi(updateDocumentRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");

  const updatedDocument = await updateDocument({
    id,
    teamId: team.id,
    organizationId: team.organizationId,
    updates,
  });

  if (!updatedDocument) {
    return throwHttpError(404, notFound());
  }

  return c.json(formatDocumentResponse(updatedDocument), 200);
});

/**
 * -- RE-EXTRACT DOCUMENT
 * --
 * Re-runs the extraction pipeline for a settled document (after a failed run,
 * a field-template change, or a model upgrade). Enqueues a forced re-run and
 * returns immediately; the document flips back to `processing`.
 */
documentRoutes.openapi(reextractDocumentRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id } = c.req.valid("param");
  await reextractDocument({
    documentId: id,
    teamId: team.id,
    organizationId: team.organizationId,
  });

  return c.json({ success: true }, 202);
});

/**
 * -- CREATE A WRITTEN DOCUMENT
 * --
 */
documentRoutes.openapi(createAuthoredDocumentRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { title, content, folderId } = c.req.valid("json");

  const document = await createAuthoredDocument({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    title,
    content,
    folderId: folderId ?? null,
    actorContext: { actor: "human", userId: user.id },
    eventActor: { actorType: "user", actorUserId: user.id },
  });

  return c.json(formatDocumentResponse(document), 201);
});

/**
 * -- READ A WRITTEN DOCUMENT
 * --
 */
documentRoutes.openapi(getDocumentContentRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id } = c.req.valid("param");
  const { document, content } = await getAuthoredContent({
    documentId: id,
    teamId: team.id,
  });

  return c.json({ document: formatDocumentResponse(document), content }, 200);
});

/**
 * -- SAVE A WRITTEN DOCUMENT
 * --
 */
documentRoutes.openapi(saveDocumentContentRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id } = c.req.valid("param");
  const { content, baseUpdatedAt } = c.req.valid("json");

  const result = await saveAuthoredContent({
    documentId: id,
    teamId: team.id,
    organizationId: team.organizationId,
    content,
    actorContext: { actor: "human", userId: user.id },
    ...(baseUpdatedAt ? { expectedUpdatedAt: baseUpdatedAt } : {}),
  });

  return c.json(
    {
      document: formatDocumentResponse(result.document),
      version: formatVersionResponse(result.version),
      unchanged: result.unchanged,
    },
    200,
  );
});

/**
 * -- LIST VERSIONS
 * --
 */
documentRoutes.openapi(listDocumentVersionsRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id } = c.req.valid("param");
  const versions = await listDocumentVersions({
    documentId: id,
    teamId: team.id,
  });

  return c.json(
    versions.map((v) => ({
      ...formatVersionResponse(v),
      byUserName: v.byUserName,
      origin: v.origin,
      isCurrent: v.isCurrent,
    })),
    200,
  );
});

/**
 * -- RESTORE A VERSION
 * --
 */
documentRoutes.openapi(restoreDocumentVersionRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id, versionId } = c.req.valid("param");
  const result = await restoreDocumentVersion({
    documentId: id,
    teamId: team.id,
    organizationId: team.organizationId,
    versionId,
    actorContext: { actor: "human", userId: user.id },
  });

  return c.json(
    {
      document: formatDocumentResponse(result.document),
      version: formatVersionResponse(result.version),
      unchanged: result.unchanged,
    },
    200,
  );
});

/**
 * -- DOWNLOAD ONE VERSION
 * --
 */
documentRoutes.openapi(downloadDocumentVersionRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const { id, versionId } = c.req.valid("param");
  const result = await getDocumentVersionDownloadUrl({
    documentId: id,
    versionId,
    teamId: team.id,
  });

  return c.json(result, 200);
});

/**
 * -- LIST RECENT DOCUMENTS
 * --
 * Team-wide recent documents for the home "Recent files" card.
 */
documentRoutes.openapi(listRecentDocumentsRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  const params = c.req.valid("query");
  const result = await listRecentDocuments({ teamId: team.id, params });

  return c.json(result, 200);
});

/**
 * -- GET DOCUMENT DETAILS
 * --
 * Returns document details including a presigned file URL, the team's
 * field definitions, and the document's resolved field values — enough
 * for the frontend to render the dynamic right panel without further
 * round-trips.
 */
documentRoutes.openapi(getDocumentDetailsRoute, async (c) => {
  const team = c.get("team");
  if (!team) {
    return c.json(teamRequired(), 403);
  }

  const { id } = c.req.valid("param");

  const { document, fileUrl, fieldValues, fieldDefinitions } =
    await getDocumentDetails({ id, teamId: team.id });

  const breadcrumbs = await getDocumentBreadcrumbs({
    document: {
      id: document.id,
      originalFilename: document.originalFilename,
      folderId: document.folderId,
    },
    teamId: team.id,
  });

  // Drizzle returns numeric/decimal as string — coerce before serialising
  // so the response matches the OpenAPI schema (confidenceScore: number).
  const properties = document.properties
    ? {
        ...document.properties,
        confidenceScore: document.properties.confidenceScore
          ? Number(document.properties.confidenceScore)
          : null,
      }
    : null;

  return c.json(
    {
      id: document.id,
      teamId: document.teamId,
      folderId: document.folderId,
      status: document.status,
      source: document.source,
      errorMessage: document.errorMessage,
      originalFilename: document.originalFilename,
      fileSize: document.fileSize,
      mimeType: document.mimeType,
      uploadedById: document.uploadedById,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      uploadedBy: document.uploadedBy,
      folder: document.folder,
      properties,
      breadcrumbs,
      fileUrl,
      fieldValues,
      fieldDefinitions,
    },
    200,
  );
});

export { documentRoutes };
