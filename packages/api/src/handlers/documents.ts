import {
  idsByTeam,
  requireAccessForEachResolved,
} from "@fretik/shared/authz/access";
import { requireDriveMove } from "@fretik/shared/authz/drive";
import { driveVisibility } from "@fretik/shared/authz/drive-sql";
import { access, teamOfResource } from "@fretik/shared/authz/http";
import { requirePlacement } from "@fretik/shared/authz/placement";
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
  DocumentPreviewSourceSchema,
  DocumentResponseSchema,
  DocumentVersionDownloadSchema,
  DocumentVersionSchema,
  FilingFeedbackResponseSchema,
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
import { getDocumentPreviewSource } from "@fretik/shared/services/documents/preview";
import {
  getUploadProgress,
  streamUploadProgress,
} from "@fretik/shared/services/documents/progress";
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
import { confirmAutoFiling } from "@fretik/shared/services/folders/confirm-filing";
import { undoAutoFiling } from "@fretik/shared/services/folders/undo-filing";
import { readProjectName } from "@fretik/shared/services/projects/read";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

// ==================== //
// ROUTER SETUP         //
// ==================== //

/**
 * Each route on one document names the level it takes (`access.resource`):
 * view to open, preview or download it, edit to change, rename, move or
 * re-extract it, full to delete it. Adding a document — an upload, a written
 * one, a move — also takes edit on the folder it lands in.
 */
const documentRoutes = new OpenAPIHono<HonoLoggedAppType>();
documentRoutes.use("*", authMiddleware);

// ==================== //
// HELPERS              //
// ==================== //

const formatDocumentResponse = (doc: Document) => ({
  id: doc.id,
  teamId: doc.teamId,
  folderId: doc.folderId,
  projectId: doc.projectId,
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
  middleware: access.handler(
    "Where it lands (`authz/placement.ts`): edit on its folder, taking part in its project, or contributing to the active team at its root.",
  ),
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
  middleware: access.session(
    "The active team's recent Drive documents, only those the caller can open (authz/drive-sql).",
  ),
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
  middleware: access.resource("document", "edit"),
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
  middleware: access.handler(
    "Each document takes full access, and is deleted in its own team; ids out of sight are skipped (requireAccessForEachResolved).",
  ),
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
  middleware: access.resource("document", "view"),
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
  middleware: access.resource("document", "edit"),
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
 * -- AUTOMATIC FILING FEEDBACK
 * --
 * A person's two answers to the Drive filer: "not there" (undo, back to the
 * root) and "that's right" (confirm, nothing moves). Both label the filing
 * decision; both refuse once the document has left the folder it was filed in.
 */
const undoFilingRoute = createRoute({
  method: "post",
  path: "/{id}/filing/undo",
  // Back to the root of its own tree: a move that stays in its project.
  middleware: access.resource("document", "edit"),
  summary: "Undo an automatic filing",
  description:
    "Moves a document the Drive filer placed back to the root, and records that the filing was wrong. 409 when the document has been moved since.",
  tags: ["Documents"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: FilingFeedbackResponseSchema },
      },
      description: "Filing undone",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const confirmFilingRoute = createRoute({
  method: "post",
  path: "/{id}/filing/confirm",
  // Saying where a document belongs is placing it, whether or not it moves.
  middleware: access.resource("document", "edit"),
  summary: "Confirm an automatic filing",
  description:
    "Records that the folder the Drive filer chose is the right one. Nothing moves. 409 when the document has been moved since.",
  tags: ["Documents"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: FilingFeedbackResponseSchema },
      },
      description: "Filing confirmed",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseConflictSchema,
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
  middleware: access.handler(
    "Where it lands (`authz/placement.ts`): edit on its folder, taking part in its project, or contributing to the active team at its root.",
  ),
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
  middleware: access.resource("document", "view"),
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
  middleware: access.resource("document", "edit"),
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
  middleware: access.resource("document", "view"),
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
  middleware: access.resource("document", "edit"),
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

/**
 * -- GET A DOCUMENT'S PREVIEW SOURCE
 * --
 * Its own route rather than a field on the details payload: the first
 * request for a convertible file runs a LibreOffice conversion, and a
 * details response carrying breadcrumbs and field values has no business
 * waiting on Gotenberg — or failing with it. The viewer asks for this
 * separately and shows its own spinner.
 */
const getDocumentPreviewSourceRoute = createRoute({
  method: "get",
  path: "/{id}/preview-source",
  middleware: access.resource("document", "view"),
  summary: "Get what a viewer should render for a document",
  description:
    "A short-lived link to what the viewer should fetch when a document's own bytes cannot be rendered in a browser: a PDF rendering (legacy Office, OpenDocument, RTF, TIFF) or the extracted markdown sidecar (mail). `kind` is null for a type that renders from its own bytes.",
  tags: ["Documents"],
  request: {
    params: paramsIdSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: DocumentPreviewSourceSchema },
      },
      description: "The preview source, or nulls when none is needed",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const downloadDocumentVersionRoute = createRoute({
  method: "get",
  path: "/{id}/versions/{versionId}/download",
  middleware: access.resource("document", "view"),
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
  const principal = c.get("principal");
  const { file, folderId, projectId, onConflict } = c.req.valid("form");
  const placement = await requirePlacement({
    principal,
    activeTeamId: c.get("team")?.id,
    folderId,
    projectId,
  });

  const result = await uploadDocument({
    file,
    organizationId: principal.organizationId,
    teamId: placement.teamId,
    principal,
    folderId,
    projectId: placement.projectId,
    onConflict,
  });

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
documentRoutes.get(
  "/upload/:documentId/progress",
  access.resource("document", "view", "documentId"),
  async (c) => {
    const teamId = teamOfResource(c.get("resource"));

    // The progress bus is keyed by document id alone, so the authorization is
    // this pre-check: once the stream is open it relays whatever it is told.
    // A malformed id is refused here too — Postgres would reject it as a uuid
    // and surface a 500.
    const documentId = c.req.param("documentId");
    if (
      !z.uuid().safeParse(documentId).success ||
      !(await getUploadProgress({ documentId, teamId }))
    ) {
      return throwHttpError(404, notFound());
    }

    applyAntiBufferingHeaders(c);
    return streamSSE(c, async (stream) => {
      await streamUploadProgress({ documentId, teamId, stream });
    });
  },
);

/**
 * -- DELETE DOCUMENTS
 * --
 */
documentRoutes.openapi(deleteDocumentsRoute, async (c) => {
  const { ids } = c.req.valid("json");
  const deletable = await requireAccessForEachResolved({
    principal: c.get("principal"),
    type: "document",
    ids,
    required: "full",
  });

  // Each in its own team: a selection made in a folder shared from another
  // team is that team's.
  let rowCount = 0;
  for (const [teamId, teamIds] of idsByTeam(deletable)) {
    // oxlint-disable-next-line no-await-in-loop -- one team, rarely two
    rowCount += (await deleteDocuments({ ids: teamIds, teamId })).rowCount ?? 0;
  }

  return c.json({ rowCount }, 200);
});

/**
 * -- UPDATE DOCUMENT
 * --
 */
documentRoutes.openapi(updateDocumentRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");

  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");
  if (updates.folderId !== undefined) {
    await requireDriveMove(c.get("principal"), {
      type: "document",
      id,
      folderId: updates.folderId,
    });
  }

  const updatedDocument = await updateDocument({
    id,
    teamId,
    organizationId,
    updates,
  });

  if (!updatedDocument) {
    return throwHttpError(404, notFound());
  }

  return c.json(formatDocumentResponse(updatedDocument), 200);
});

/**
 * -- UNDO / CONFIRM AUTOMATIC FILING
 * --
 */
// Both act in the document's own team, whichever the caller has open.
documentRoutes.openapi(undoFilingRoute, async (c) => {
  const { id } = c.req.valid("param");
  const result = await undoAutoFiling({
    documentId: id,
    teamId: teamOfResource(c.get("resource")),
    userId: c.get("user").id,
  });
  return c.json(result, 200);
});

documentRoutes.openapi(confirmFilingRoute, async (c) => {
  const { id } = c.req.valid("param");
  const result = await confirmAutoFiling({
    documentId: id,
    teamId: teamOfResource(c.get("resource")),
    userId: c.get("user").id,
  });
  return c.json(result, 200);
});

/**
 * -- RE-EXTRACT DOCUMENT
 * --
 * Re-runs the extraction pipeline for a settled document (after a failed run,
 * a field-template change, or a model upgrade). Enqueues a forced re-run and
 * returns immediately; the document flips back to `processing`.
 */
documentRoutes.openapi(reextractDocumentRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");

  const { id } = c.req.valid("param");
  await reextractDocument({
    documentId: id,
    teamId,
    organizationId,
  });

  return c.json({ success: true }, 202);
});

/**
 * -- CREATE A WRITTEN DOCUMENT
 * --
 */
documentRoutes.openapi(createAuthoredDocumentRoute, async (c) => {
  const user = c.get("user");
  const principal = c.get("principal");
  const { title, content, folderId, projectId } = c.req.valid("json");
  const placement = await requirePlacement({
    principal,
    activeTeamId: c.get("team")?.id,
    folderId,
    projectId,
  });

  const document = await createAuthoredDocument({
    organizationId: principal.organizationId,
    teamId: placement.teamId,
    userId: user.id,
    title,
    content,
    folderId: folderId ?? null,
    projectId: placement.projectId,
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
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const { document, content } = await getAuthoredContent({
    documentId: id,
    teamId,
  });

  return c.json({ document: formatDocumentResponse(document), content }, 200);
});

/**
 * -- SAVE A WRITTEN DOCUMENT
 * --
 */
documentRoutes.openapi(saveDocumentContentRoute, async (c) => {
  const user = c.get("user");
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");

  const { id } = c.req.valid("param");
  const { content, baseUpdatedAt } = c.req.valid("json");

  const result = await saveAuthoredContent({
    documentId: id,
    teamId,
    organizationId,
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
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const versions = await listDocumentVersions({
    documentId: id,
    teamId,
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
  const teamId = teamOfResource(c.get("resource"));
  const { organizationId } = c.get("principal");

  const { id, versionId } = c.req.valid("param");
  const result = await restoreDocumentVersion({
    documentId: id,
    teamId,
    organizationId,
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
  const teamId = teamOfResource(c.get("resource"));

  const { id, versionId } = c.req.valid("param");
  const result = await getDocumentVersionDownloadUrl({
    documentId: id,
    versionId,
    teamId,
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
  const result = await listRecentDocuments({
    principal: c.get("principal"),
    teamId: team.id,
    params,
  });

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
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");

  const visibility = await driveVisibility(c.get("principal"), teamId);
  const { document, fileUrl, fieldValues, fieldDefinitions } =
    await getDocumentDetails({ id, teamId, visibility });

  const breadcrumbs = await getDocumentBreadcrumbs({
    document: {
      id: document.id,
      originalFilename: document.originalFilename,
      folderId: document.folderId,
    },
    teamId,
    visibility,
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

  const project =
    document.projectId === null
      ? null
      : await readProjectName(document.projectId);

  return c.json(
    {
      id: document.id,
      teamId: document.teamId,
      folderId: document.folderId,
      projectId: document.projectId,
      project,
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
      level: c.get("resource").level,
    },
    200,
  );
});

/**
 * -- GET A DOCUMENT'S PREVIEW SOURCE
 * --
 * For a convertible type this renders on the first request and serves the
 * cached object thereafter; for mail it points at the markdown the
 * extraction pipeline already wrote.
 */
documentRoutes.openapi(getDocumentPreviewSourceRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const source = await getDocumentPreviewSource({ id, teamId });

  return c.json(source, 200);
});

export { documentRoutes };
