import { and, count, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import db from "../../db";
import {
  documents,
  folders,
  type DocumentStatus,
  type DocumentType,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import type { ParamsList } from "../../schemas";
import type {
  DriveItem,
  FolderBreadcrumb,
  FolderResponse,
} from "../../schemas/folders";

/**
 * Retrieves the root drive for a team.
 */
export const getRootDrive = async (data: {
  teamId: string;
  params: ParamsList;
}) => {
  const { teamId, params } = data;

  return getFolderExplorer({
    folderId: null,
    teamId,
    params,
  });
};

/**
 * Retrieves a specific folder and its children.
 */
export const getFolder = async (data: {
  folderId: string;
  teamId: string;
  params: ParamsList;
}) => {
  const { folderId, teamId, params } = data;

  return getFolderExplorer({
    folderId,
    teamId,
    params,
  });
};

/**
 * Retrieves the breadcrumbs for a specific folder.
 */
export const getFolderBreadcrumbs = async (data: {
  folderId: string | null;
  teamId: string;
}): Promise<FolderBreadcrumb[]> => {
  const { folderId, teamId } = data;
  const breadcrumbs: FolderBreadcrumb[] = [{ id: null, name: "/" }];

  if (!folderId) {
    return breadcrumbs;
  }

  const breadcrumbsResult = await db.execute<{
    id: string;
    name: string;
  }>(sql`
    WITH RECURSIVE folder_parents AS (
        SELECT id, name, parent_folder_id, 0 as level
        FROM folders
        WHERE id = ${folderId} AND team_id = ${teamId}
        
        UNION ALL
        
        SELECT f.id, f.name, f.parent_folder_id, fp.level + 1
        FROM folders f
        INNER JOIN folder_parents fp ON f.id = fp.parent_folder_id
        WHERE f.team_id = ${teamId}
    )
    SELECT id, name FROM folder_parents ORDER BY level DESC
  `);

  breadcrumbs.push(
    ...breadcrumbsResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
    })),
  );

  return breadcrumbs;
};

/**
 * Generates presigned thumbnail URLs for a list of documents in parallel.
 * Only generates URLs for documents with status 'ready'.
 */
const mapDocsToDriveItems = async <
  T extends {
    id: string;
    originalFilename: string;
    fileSize: number;
    mimeType: string;
    status: DocumentStatus;
    s3ThumbnailKey: string;
    createdAt: Date;
    updatedAt: Date;
    properties: {
      documentType: DocumentType;
      transportType: { code: string; icon: string | null } | null;
    } | null;
  },
>(
  docs: T[],
): Promise<DriveItem[]> => {
  const readyDocs = docs.filter((d) => d.status === "ready");
  const thumbnailUrls = await Promise.all(
    readyDocs.map((d) => getPresignedUrl(d.s3ThumbnailKey)),
  );

  const urlMap = new Map<string, string>();
  for (const [i, d] of readyDocs.entries()) {
    urlMap.set(d.id, thumbnailUrls[i] ?? "");
  }

  return docs.map((d) => ({
    type: "document" as const,
    data: {
      id: d.id,
      name: d.originalFilename,
      fileSize: d.fileSize,
      mimeType: d.mimeType,
      status: d.status,
      thumbnailUrl: urlMap.get(d.id) ?? null,
      documentType: d.properties?.documentType ?? "unknown",
      documentTransportType: d.properties?.transportType ?? null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    },
  }));
};

/**
 * Retrieves folder explorer data including folder details, children, and breadcrumbs.
 */
const getFolderExplorer = async (data: {
  folderId: string | null;
  teamId: string;
  params: ParamsList;
}) => {
  const { folderId, teamId, params } = data;
  const { page, limit, search } = params;
  const offset = page * limit;
  const isRoot = !folderId;

  let currentFolder: FolderResponse | null = null;

  if (folderId) {
    // 1. Fetch current folder metadata
    const folder = await db.query.folders.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) {
      return throwHttpError(404, notFound());
    }
    currentFolder = folder;
  }

  // 2. Fetch breadcrumbs
  const breadcrumbs = await getFolderBreadcrumbs({ folderId, teamId });

  // 3. Compute counts
  let totalFoldersCount = 0;
  let totalDocumentsCount = 0;

  if (isRoot) {
    const [subFoldersCountResult] = await db
      .select({ count: count() })
      .from(folders)
      .where(
        and(
          eq(folders.teamId, teamId),
          isNull(folders.parentFolderId),
          ...(search ? [ilike(folders.name, `%${search}%`)] : []),
        ),
      );

    const [documentsCountResult] = await db
      .select({ count: count() })
      .from(documents)
      .where(
        and(
          eq(documents.teamId, teamId),
          isNull(documents.folderId),
          ne(documents.status, "error"),
          ...(search ? [ilike(documents.originalFilename, `%${search}%`)] : []),
        ),
      );

    totalFoldersCount = subFoldersCountResult?.count || 0;
    totalDocumentsCount = documentsCountResult?.count || 0;
  } else if (currentFolder) {
    totalFoldersCount = currentFolder.subFolderCount;
    totalDocumentsCount = currentFolder.documentCount;
  }

  const totalItemsCount = totalFoldersCount + totalDocumentsCount;
  const children: DriveItem[] = [];

  const docColumns = {
    id: true,
    originalFilename: true,
    fileSize: true,
    mimeType: true,
    status: true,
    s3ThumbnailKey: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  const docWhere = {
    teamId,
    folderId: isRoot ? ({ isNull: true } as const) : folderId,
    status: { ne: "error" as const },
    ...(search && { originalFilename: { ilike: `%${search}%` } }),
  };

  // 4. Fetch children
  if (offset < totalFoldersCount) {
    const folderLimit = Math.min(limit, totalFoldersCount - offset);
    const subFolders = await db.query.folders.findMany({
      where: {
        teamId,
        parentFolderId: isRoot ? { isNull: true } : folderId,
        ...(search && { name: { ilike: `%${search}%` } }),
      },
      orderBy: { updatedAt: "desc" },
      limit: folderLimit,
      offset: offset,
    });

    children.push(
      ...subFolders.map((f) => ({ type: "folder" as const, data: f })),
    );

    if (children.length < limit && totalDocumentsCount > 0) {
      const remainingLimit = limit - children.length;
      const subDocs = await db.query.documents.findMany({
        columns: docColumns,
        where: docWhere,
        with: {
          properties: {
            columns: {
              documentType: true,
            },
            with: {
              transportType: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        limit: remainingLimit,
      });

      children.push(...(await mapDocsToDriveItems(subDocs)));
    }
  } else {
    const docOffset = offset - totalFoldersCount;
    const subDocs = await db.query.documents.findMany({
      columns: docColumns,
      where: docWhere,
      with: {
        properties: {
          columns: {
            documentType: true,
          },
          with: {
            transportType: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      limit: limit,
      offset: docOffset,
    });

    children.push(...(await mapDocsToDriveItems(subDocs)));
  }

  return {
    folder: currentFolder,
    children: {
      count: totalItemsCount,
      data: children,
    },
    breadcrumbs,
  };
};
