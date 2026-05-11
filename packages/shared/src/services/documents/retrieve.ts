import db from "../../db";
import type { DocumentStatus, DocumentType } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import type { FolderBreadcrumb } from "../../schemas/folders";
import { getFolderBreadcrumbs } from "../folders/retrieve";

/**
 * Shared document search/list service.
 *
 * Single entry point for every caller that needs a filtered, paginated
 * list of documents scoped to a team: the chatbot's `listDocuments`
 * domain tool, and any future API handler.
 *
 * Filters (all optional):
 * - `search`: case-insensitive substring match on `originalFilename`.
 * - `documentType`: exact match on the pre-extraction `documentType`
 *   (`invoice`, `contract`, …) — resolved via the `properties` relation.
 * - `folderId`: restrict to a specific folder; pass `null` to restrict
 *   to team-root documents. Omit to search across every folder.
 * - `status`: processing status. Omit to return every status.
 * - `includeThumbnailUrl` (default `false`): generates presigned S3
 *   thumbnail URLs for `ready` documents. Off by default because
 *   presigning is remote, serial, and only the drive UI needs it.
 *
 * Pagination: `limit` (default 20), `offset` (default 0). The service
 * fetches `limit + 1` rows to compute `hasMore` in a single query and
 * no `COUNT(*)` is issued — callers that need a total should call a
 * dedicated counter. The trailing row is stripped from the returned
 * `documents` array.
 */
export interface SearchDocumentsFilters {
  search?: string;
  documentType?: DocumentType;
  folderId?: string | null;
  status?: DocumentStatus;
}

export interface SearchDocumentsOptions extends SearchDocumentsFilters {
  teamId: string;
  limit?: number;
  offset?: number;
  includeThumbnailUrl?: boolean;
}

export interface SearchDocumentsRow {
  id: string;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  status: DocumentStatus;
  folder: { id: string; name: string } | null;
  documentType: DocumentType | null;
  pageCount: number | null;
  entityCount: number;
  thumbnailUrl: string | null;
  s3ThumbnailKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchDocumentsResult {
  documents: SearchDocumentsRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export const searchDocuments = async (
  opts: SearchDocumentsOptions,
): Promise<SearchDocumentsResult> => {
  const {
    teamId,
    search,
    documentType,
    folderId,
    status,
    limit = 20,
    offset = 0,
    includeThumbnailUrl = false,
  } = opts;

  const rows = await db.query.documents.findMany({
    where: {
      teamId,
      ...(status && { status }),
      ...(search && { originalFilename: { ilike: `%${search}%` } }),
      ...(folderId === null
        ? { folderId: { isNull: true } }
        : typeof folderId === "string"
          ? { folderId }
          : {}),
      ...(documentType && {
        properties: { documentType },
      }),
    },
    columns: {
      id: true,
      originalFilename: true,
      fileSize: true,
      mimeType: true,
      status: true,
      s3ThumbnailKey: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      folder: {
        columns: { id: true, name: true },
      },
      properties: {
        columns: { documentType: true, pageCount: true },
      },
      documentEntities: {
        columns: { id: true },
      },
    },
    orderBy: { createdAt: "desc" },
    limit: limit + 1,
    offset,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const thumbnailMap = new Map<string, string>();
  if (includeThumbnailUrl) {
    const readyRows = pageRows.filter((r) => r.status === "ready");
    const urls = await Promise.all(
      readyRows.map((r) => getPresignedUrl(r.s3ThumbnailKey)),
    );
    for (const [i, r] of readyRows.entries()) {
      thumbnailMap.set(r.id, urls[i] ?? "");
    }
  }

  return {
    documents: pageRows.map((r) => ({
      id: r.id,
      originalFilename: r.originalFilename,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      status: r.status,
      folder: r.folder ? { id: r.folder.id, name: r.folder.name } : null,
      documentType: r.properties?.documentType ?? null,
      pageCount: r.properties?.pageCount ?? null,
      entityCount: r.documentEntities.length,
      thumbnailUrl: includeThumbnailUrl
        ? (thumbnailMap.get(r.id) ?? null)
        : null,
      s3ThumbnailKey: r.s3ThumbnailKey,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    limit,
    offset,
    hasMore,
  };
};

/**
 * Retrieves all document transport types sorted by code (name).
 */
export const getDocumentTransportTypes = async () => {
  return await db.query.documentTransportTypes.findMany({
    orderBy: { code: "asc" },
  });
};

/**
 * Retrieves the breadcrumbs for a specific document based on its folder.
 */
export const getDocumentBreadcrumbs = async (data: {
  document: {
    id: string;
    originalFilename: string;
    folderId: string | null;
  };
  teamId: string;
}): Promise<FolderBreadcrumb[]> => {
  const { document } = data;
  const breadcrumbs = document.folderId
    ? await getFolderBreadcrumbs({
        folderId: document.folderId,
        teamId: data.teamId,
      })
    : [{ id: null, name: "/" }];

  breadcrumbs.push({ id: document.id, name: document.originalFilename });

  return breadcrumbs;
};

/**
 * Retrieves detailed information about a document.
 * Includes processings, uploader info, and folder.
 */
export const getDocumentDetails = async (data: {
  id: string;
  teamId: string;
}) => {
  const document = await db.query.documents.findFirst({
    where: { id: data.id, teamId: data.teamId },
    with: {
      uploadedBy: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      folder: {
        columns: { id: true, name: true },
      },
      properties: {
        columns: {
          id: true,
          pageCount: true,
          documentType: true,
          documentTransportType: true,
          documentLanguage: true,
          documentSummary: true,
          documentDate: true,
          documentNumber: true,
          transportMode: true,
          completedAt: true,
          createdAt: true,
        },
      },
      labels: {
        columns: { id: true, name: true, color: true },
      },
    },
  });

  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }

  const fileUrl =
    document.status === "ready" ? await getPresignedUrl(document.s3Key) : null;

  return { ...document, fileUrl };
};
