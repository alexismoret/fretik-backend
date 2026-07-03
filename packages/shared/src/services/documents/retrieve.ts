import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../../db";
import type { DocumentStatus, FieldDefinition } from "../../db/schema";
import { documents, objectTypes, team } from "../../db/schema";
import {
  buildDocumentOriginalKey,
  buildDocumentThumbnailKey,
} from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import type { FolderBreadcrumb } from "../../schemas/folders";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { getFolderBreadcrumbs } from "../folders/retrieve";
import { qualifiedObjectTable, SAFE_IDENT } from "../object-schema/identifiers";
import {
  readRecordData,
  readRecordDataBatch,
} from "../object-schema/record-io";
import { DOCUMENT_TYPE_KEY } from "../object-types/constants";

/** Resolve a team's org-scoped `document` object-type id (its extension table). */
const resolveDocumentTypeId = async (
  teamId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ id: objectTypes.id })
    .from(objectTypes)
    .innerJoin(team, eq(team.organizationId, objectTypes.organizationId))
    .where(
      and(
        eq(team.id, teamId),
        eq(objectTypes.key, DOCUMENT_TYPE_KEY),
        isNull(objectTypes.teamId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
};

/**
 * Shared document search/list service.
 *
 * Single entry point for every caller that needs a filtered, paginated
 * list of documents scoped to a team: the chatbot's `listDocuments`
 * domain tool and the drive API.
 *
 * Filters (all optional):
 * - `search`: case-insensitive substring on `originalFilename`.
 * - `folderId`: restrict to a specific folder; pass `null` to restrict
 *   to team-root documents. Omit to search across every folder.
 * - `status`: processing status. Omit to return every status.
 * - `entityIds`: any-of match on the records the document mentions
 *   (its mirror record's `mentions` links).
 * - `customFilters`: equality on `(fieldKey, value)` against the document
 *   mirror record's `data`. Each entry produces an `EXISTS` sub-select
 *   correlated on the document id — AND semantics across entries.
 * - `includeThumbnailUrl` (default `false`): generates presigned S3
 *   thumbnail URLs for `ready` documents. Off by default because
 *   presigning is remote, serial, and only the drive UI needs it.
 *
 * Pagination: `limit` (default 20), `offset` (default 0). Fetches
 * `limit + 1` rows to compute `hasMore` without a `COUNT(*)`.
 */
export interface SearchDocumentsFilters {
  search?: string;
  folderId?: string | null;
  status?: DocumentStatus;
  entityIds?: string[];
  customFilters?: { fieldKey: string; value: unknown }[];
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
  pageCount: number | null;
  entityCount: number;
  /**
   * Per-document custom field values keyed by `fieldDefinitions.key`.
   * Empty object when no custom values exist; callers can still match
   * against the `fieldDefinitions` carried by the parent response.
   */
  fieldValues: Record<string, unknown>;
  thumbnailUrl: string | null;
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
    folderId,
    status,
    entityIds,
    customFilters,
    limit = 20,
    offset = 0,
    includeThumbnailUrl = false,
  } = opts;

  // Custom filter clauses are `EXISTS` sub-selects correlated on the document's
  // 1:1 mirror record: join the document type's extension table and compare the
  // real typed column (as text, so any primitive value works). Keys are
  // slug-guarded; values parameterized. No-op when the document type is absent.
  const docTypeId = await resolveDocumentTypeId(teamId);
  const docTable = docTypeId ? qualifiedObjectTable(docTypeId) : null;
  const customFilterExists = docTable
    ? (customFilters ?? [])
        .filter((cf) => SAFE_IDENT.test(cf.fieldKey))
        .map(
          (cf) =>
            sql`EXISTS (SELECT 1 FROM object_records r JOIN ${sql.raw(docTable)} e ON e."id" = r.id WHERE r.document_id = ${documents.id} AND e.${sql.raw(`"${cf.fieldKey}"`)}::text = ${String(cf.value)})`,
        )
    : [];

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
      ...(entityIds && entityIds.length > 0
        ? { mirrorRecord: { outgoingLinks: { toRecordId: { in: entityIds } } } }
        : {}),
      ...(customFilterExists.length > 0
        ? { RAW: and(...customFilterExists) }
        : {}),
    },
    columns: {
      id: true,
      originalFilename: true,
      fileSize: true,
      mimeType: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      folder: {
        columns: { id: true, name: true },
      },
      properties: {
        columns: { pageCount: true },
      },
      mirrorRecord: {
        columns: { id: true },
        with: { outgoingLinks: { columns: { id: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    limit: limit + 1,
    offset,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Batch-reconstruct each mirror record's typed field values in one query.
  const mirrorIds = pageRows
    .map((r) => r.mirrorRecord?.id)
    .filter((id): id is string => typeof id === "string");
  const fieldValuesById =
    docTypeId && mirrorIds.length > 0
      ? await readRecordDataBatch({
          objectTypeId: docTypeId,
          recordIds: mirrorIds,
          fields: await getFieldDefinitionsForTeam({
            teamId,
            objectTypeId: docTypeId,
          }),
        })
      : new Map<string, Record<string, unknown>>();

  const thumbnailMap = new Map<string, string>();
  if (includeThumbnailUrl) {
    const readyRows = pageRows.filter((r) => r.status === "ready");
    const urls = await Promise.all(
      readyRows.map((r) => getPresignedUrl(buildDocumentThumbnailKey(r.id))),
    );
    for (const [i, r] of readyRows.entries()) {
      thumbnailMap.set(r.id, urls[i] ?? "");
    }
  }

  return {
    documents: pageRows.map((r) => {
      return {
        id: r.id,
        originalFilename: r.originalFilename,
        fileSize: r.fileSize,
        mimeType: r.mimeType,
        status: r.status,
        folder: r.folder ? { id: r.folder.id, name: r.folder.name } : null,
        pageCount: r.properties?.pageCount ?? null,
        entityCount: r.mirrorRecord?.outgoingLinks.length ?? 0,
        fieldValues: r.mirrorRecord
          ? (fieldValuesById.get(r.mirrorRecord.id) ?? {})
          : {},
        thumbnailUrl: includeThumbnailUrl
          ? (thumbnailMap.get(r.id) ?? null)
          : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
    limit,
    offset,
    hasMore,
  };
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

type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>;

/**
 * Retrieves detailed information about a document plus the team's field
 * definitions and the document's field values — enough to render the
 * dynamic right panel in a single round-trip.
 */
export const getDocumentDetails = async (data: {
  id: string;
  teamId: string;
}): Promise<{
  document: LoadedDocument;
  fileUrl: string | null;
  fieldValues: Record<string, unknown>;
  fieldDefinitions: FieldDefinition[];
}> => {
  const document = await loadDocument(data);

  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }

  const fileUrl =
    document.status === "ready"
      ? await getPresignedUrl(
          buildDocumentOriginalKey(document.id, document.originalFilename),
        )
      : null;

  const fieldDefinitions = await getFieldDefinitionsForTeam({
    teamId: data.teamId,
  });

  const fieldValues: Record<string, unknown> = document.mirrorRecord
    ? await readRecordData({
        objectTypeId: document.mirrorRecord.objectTypeId,
        recordId: document.mirrorRecord.id,
        fields: fieldDefinitions,
      })
    : {};

  return { document, fileUrl, fieldValues, fieldDefinitions };
};

const loadDocument = async (data: { id: string; teamId: string }) => {
  return await db.query.documents.findFirst({
    where: { id: data.id, teamId: data.teamId },
    with: {
      uploadedBy: {
        columns: { id: true, name: true, image: true },
      },
      folder: {
        columns: { id: true, name: true },
      },
      properties: {
        columns: {
          id: true,
          pageCount: true,
          documentLanguage: true,
          documentSummary: true,
          confidenceScore: true,
          completedAt: true,
          createdAt: true,
        },
      },
      mirrorRecord: {
        columns: { id: true, objectTypeId: true },
      },
    },
  });
};
