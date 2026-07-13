import type { Document } from "@fretik/shared/db/schema";
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
  bodyIdListSchema,
  DocumentResponseSchema,
  GetDocumentDetailsResponseSchema,
  UpdateDocumentSchema,
  UploadDocumentSchema,
} from "@fretik/shared/schemas";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseCreatedSchemaBuilder,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessDeletedSchema,
} from "@fretik/shared/schemas/common/responses";
import { deleteDocuments } from "@fretik/shared/services/documents/delete";
import { streamUploadProgress } from "@fretik/shared/services/documents/progress";
import { reextractDocument } from "@fretik/shared/services/documents/reextract";
import {
  getDocumentBreadcrumbs,
  getDocumentDetails,
} from "@fretik/shared/services/documents/retrieve";
import { updateDocument } from "@fretik/shared/services/documents/update";
import { uploadDocument } from "@fretik/shared/services/documents/upload";
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
  errorMessage: doc.errorMessage,
  originalFilename: doc.originalFilename,
  fileSize: doc.fileSize,
  mimeType: doc.mimeType,
  uploadedById: doc.uploadedById,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
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
      DocumentResponseSchema,
      "Document created and processing started",
    ),
    ...responseBadRequestSchema,
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

  const { file, folderId } = c.req.valid("form");

  const savedDocument = await uploadDocument(
    file,
    organization.id,
    team.id,
    user.id,
    folderId,
  );

  return c.json(formatDocumentResponse(savedDocument), 201);
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
