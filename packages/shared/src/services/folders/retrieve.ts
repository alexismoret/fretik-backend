import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import db from "../../db";
import {
  documents,
  fieldDefinitions,
  folders,
  objectTypes,
  type DocumentStatus,
  type FieldDefinitionType,
} from "../../db/schema";
import { team } from "../../db/schema/auth-schema";
import { buildDocumentThumbnailKey } from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import type {
  DriveItem,
  DriveListParams,
  FolderBreadcrumb,
  FolderResponse,
} from "../../schemas/folders";
import type { RecordFilter } from "../../schemas/ontology";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { buildFieldFilterPredicate } from "../object-schema/field-filter";
import { qualifiedObjectTable } from "../object-schema/identifiers";
import { readRecordDataBatch } from "../object-schema/record-io";
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
 * Retrieves the root drive for a team.
 */
export const getRootDrive = async (data: {
  teamId: string;
  params: DriveListParams;
}) => {
  const { teamId, params } = data;
  return getFolderExplorer({ folderId: null, teamId, params });
};

/**
 * Retrieves a specific folder and its children.
 */
export const getFolder = async (data: {
  folderId: string;
  teamId: string;
  params: DriveListParams;
}) => {
  const { folderId, teamId, params } = data;
  return getFolderExplorer({ folderId, teamId, params });
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

type DocWithRelations = {
  id: string;
  originalFilename: string;
  fileSize: number;
  mimeType: string;
  status: DocumentStatus;
  createdAt: Date;
  updatedAt: Date;
  mirrorRecord: { id: string; objectTypeId: string } | null;
};

const mapDocsToDriveItems = async (
  docs: DocWithRelations[],
  teamId: string,
): Promise<DriveItem[]> => {
  const readyDocs = docs.filter((d) => d.status === "ready");
  const thumbnailUrls = await Promise.all(
    readyDocs.map((d) => getPresignedUrl(buildDocumentThumbnailKey(d.id))),
  );

  const urlMap = new Map<string, string>();
  for (const [i, d] of readyDocs.entries()) {
    urlMap.set(d.id, thumbnailUrls[i] ?? "");
  }

  // Batch-reconstruct each mirror record's typed field values in one query.
  const docTypeId = await resolveDocumentTypeId(teamId);
  const mirrorIds = docs
    .map((d) => d.mirrorRecord?.id)
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

  return docs.map((d) => {
    return {
      type: "document" as const,
      data: {
        id: d.id,
        name: d.originalFilename,
        fileSize: d.fileSize,
        mimeType: d.mimeType,
        status: d.status,
        thumbnailUrl: urlMap.get(d.id) ?? null,
        fieldValues: d.mirrorRecord
          ? (fieldValuesById.get(d.mirrorRecord.id) ?? {})
          : {},
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      },
    };
  });
};

/**
 * True when any cross-folder field filter is active. Triggers flat
 * document-only listing mode.
 */
const hasAdvancedFilter = (params: DriveListParams): boolean =>
  params.filters.length > 0;

/**
 * EXISTS clause for one `RecordFilter` against the document's 1:1 mirror record,
 * scoped to the current `documents` row. The per-operator SQL over `e."col"` is
 * built by the shared `buildFieldFilterPredicate` — the same builder the objects
 * records list uses — here correlated through `documents → mirror record →
 * extension table`. Returns null for an unsupported filter shape.
 */
const documentFilterExists = (
  f: RecordFilter,
  fieldType: FieldDefinitionType | undefined,
  docTable: string,
): SQL | null => {
  const pred = buildFieldFilterPredicate(f, fieldType);
  if (!pred) return null;
  return sql`EXISTS (SELECT 1 FROM object_records r JOIN ${sql.raw(docTable)} e ON e."id" = r.id WHERE r.document_id = ${documents.id} AND ${pred})`;
};

/**
 * Retrieves documents matching advanced filters across all folders in a team.
 */
const getFilteredDocuments = async (data: {
  teamId: string;
  params: DriveListParams;
}): Promise<{ count: number; data: DriveItem[] }> => {
  const { teamId, params } = data;
  const { page, limit, search } = params;
  const offset = page * limit;

  const baseConditions = [
    eq(documents.teamId, teamId),
    ne(documents.status, "error"),
  ];
  if (search) {
    baseConditions.push(ilike(documents.originalFilename, `%${search}%`));
  }

  if (params.filters.length > 0) {
    const keys = params.filters.map((f) => f.key);
    const defs = await db
      .select({
        key: fieldDefinitions.key,
        type: fieldDefinitions.type,
      })
      .from(fieldDefinitions)
      .innerJoin(objectTypes, eq(fieldDefinitions.objectTypeId, objectTypes.id))
      .where(
        and(
          eq(fieldDefinitions.teamId, teamId),
          eq(objectTypes.key, DOCUMENT_TYPE_KEY),
          inArray(fieldDefinitions.key, keys),
        ),
      );
    const typeByKey = new Map<string, FieldDefinitionType>(
      defs.map((d) => [d.key, d.type]),
    );
    const docTypeId = await resolveDocumentTypeId(teamId);
    if (docTypeId) {
      const docTable = qualifiedObjectTable(docTypeId);
      for (const f of params.filters) {
        const cond = documentFilterExists(f, typeByKey.get(f.key), docTable);
        if (cond) baseConditions.push(cond);
      }
    }
  }

  const whereExpr = and(...baseConditions);

  const [countResult] = await db
    .select({ count: count() })
    .from(documents)
    .where(whereExpr);
  const totalCount = countResult?.count ?? 0;

  if (totalCount === 0) {
    return { count: 0, data: [] };
  }

  const idRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(whereExpr)
    .orderBy(desc(documents.updatedAt))
    .limit(limit)
    .offset(offset);

  const ids = idRows.map((r) => r.id);
  if (ids.length === 0) {
    return { count: totalCount, data: [] };
  }

  const docs = await db.query.documents.findMany({
    columns: {
      id: true,
      originalFilename: true,
      fileSize: true,
      mimeType: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    where: { id: { in: ids } },
    with: {
      mirrorRecord: {
        columns: { id: true, objectTypeId: true },
      },
    },
  });

  const docMap = new Map(docs.map((d) => [d.id, d]));
  const orderedDocs = ids
    .map((id) => docMap.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d);

  return {
    count: totalCount,
    data: await mapDocsToDriveItems(orderedDocs, teamId),
  };
};

/**
 * Retrieves folder explorer data including folder details, children, and breadcrumbs.
 */
const getFolderExplorer = async (data: {
  folderId: string | null;
  teamId: string;
  params: DriveListParams;
}) => {
  const { folderId, teamId, params } = data;

  if (hasAdvancedFilter(params)) {
    const children = await getFilteredDocuments({ teamId, params });
    return {
      folder: null,
      children,
      breadcrumbs: [{ id: null, name: "/" }] satisfies FolderBreadcrumb[],
    };
  }

  const { page, limit, search } = params;
  const offset = page * limit;
  const isRoot = !folderId;

  let currentFolder: FolderResponse | null = null;

  if (folderId) {
    const folder = await db.query.folders.findFirst({
      where: { id: folderId, teamId },
    });
    if (!folder) {
      return throwHttpError(404, notFound());
    }
    currentFolder = folder;
  }

  const breadcrumbs = await getFolderBreadcrumbs({ folderId, teamId });

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
    createdAt: true,
    updatedAt: true,
  } as const;

  const docWhere = {
    teamId,
    folderId: isRoot ? ({ isNull: true } as const) : folderId,
    status: { ne: "error" as const },
    ...(search && { originalFilename: { ilike: `%${search}%` } }),
  };

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
          mirrorRecord: { columns: { id: true, objectTypeId: true } },
        },
        orderBy: { updatedAt: "desc" },
        limit: remainingLimit,
      });

      children.push(...(await mapDocsToDriveItems(subDocs, teamId)));
    }
  } else {
    const docOffset = offset - totalFoldersCount;
    const subDocs = await db.query.documents.findMany({
      columns: docColumns,
      where: docWhere,
      with: {
        mirrorRecord: { columns: { id: true, objectTypeId: true } },
      },
      orderBy: { updatedAt: "desc" },
      limit: limit,
      offset: docOffset,
    });

    children.push(...(await mapDocsToDriveItems(subDocs, teamId)));
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
