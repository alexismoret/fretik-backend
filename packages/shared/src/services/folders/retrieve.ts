import {
  and,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import db from "../../db";
import {
  documentEntities,
  documentFieldValues,
  documentLabels,
  documents,
  fieldDefinitions,
  folders,
  type DocumentStatus,
  type FieldDefinitionType,
} from "../../db/schema";
import { buildDocumentThumbnailKey } from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { getPresignedUrl } from "../../lib/s3";
import type {
  DriveCustomFilter,
  DriveItem,
  DriveListParams,
  FolderBreadcrumb,
  FolderResponse,
} from "../../schemas/folders";

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
  fieldValues: { fieldKey: string; value: unknown }[];
};

const mapDocsToDriveItems = async (
  docs: DocWithRelations[],
): Promise<DriveItem[]> => {
  const readyDocs = docs.filter((d) => d.status === "ready");
  const thumbnailUrls = await Promise.all(
    readyDocs.map((d) => getPresignedUrl(buildDocumentThumbnailKey(d.id))),
  );

  const urlMap = new Map<string, string>();
  for (const [i, d] of readyDocs.entries()) {
    urlMap.set(d.id, thumbnailUrls[i] ?? "");
  }

  return docs.map((d) => {
    const fieldValues: Record<string, unknown> = {};
    for (const fv of d.fieldValues) fieldValues[fv.fieldKey] = fv.value;
    return {
      type: "document" as const,
      data: {
        id: d.id,
        name: d.originalFilename,
        fileSize: d.fileSize,
        mimeType: d.mimeType,
        status: d.status,
        thumbnailUrl: urlMap.get(d.id) ?? null,
        fieldValues,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      },
    };
  });
};

/**
 * True when any cross-folder filter is active (custom field, entity, label).
 * Triggers flat document-only listing mode.
 */
const hasAdvancedFilter = (params: DriveListParams): boolean =>
  !!(
    (params.entityId && params.entityId.length > 0) ||
    (params.labelIds && params.labelIds.length > 0) ||
    (params.customFilters && params.customFilters.length > 0)
  );

/**
 * Field types whose values are free-form strings — partial substring
 * match is the expected behaviour. Enum-like string fields
 * (`select` / `multi_select`) stay on equality.
 */
const TEXT_LIKE_TYPES: ReadonlySet<FieldDefinitionType> = new Set([
  "text",
  "url",
  "email",
]);

/**
 * Date/datetime field types — accept the `{ start, end }` range shape
 * emitted by the frontend `DateRangePicker`.
 */
const DATE_LIKE_TYPES: ReadonlySet<FieldDefinitionType> = new Set([
  "date",
  "datetime",
]);

const isDateRangeFilter = (
  v: unknown,
): v is { start: string | null; end: string | null } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  "start" in v &&
  "end" in v;

/**
 * EXISTS clause for a single `(fieldKey, value)` predicate on the
 * `document_field_values` table, scoped to the current `documents` row.
 *
 * Value shapes:
 *   • array (string[] / number[] / boolean[])   → ANY-of match
 *   • `{ start, end }` on a date/datetime field → range match (either
 *     bound may be null for an open interval)
 *   • scalar on a free-form string field        → case-insensitive
 *     substring match (ILIKE %text%)
 *   • scalar on any other type                  → equality
 */
const customFilterExists = (
  cf: DriveCustomFilter,
  fieldType: FieldDefinitionType | undefined,
) => {
  const valuePredicate = (() => {
    if (Array.isArray(cf.value)) {
      return inArray(documentFieldValues.value, cf.value as never[]);
    }
    if (
      fieldType &&
      DATE_LIKE_TYPES.has(fieldType) &&
      isDateRangeFilter(cf.value)
    ) {
      // Compare directly in JSONB space — the `(fieldKey, value)`
      // B-tree covers the range because JSONB has a total order and
      // JSON-string comparison is lexicographic (which matches
      // chronological order for ISO date / datetime strings stored as
      // JSON primitive strings).
      //
      // We send each bound already wrapped as a JSON string literal
      // (`"2025-01-01..."`) and cast to `jsonb` so the right side has
      // the same type as the column. This keeps the index in play —
      // any approach that extracts the value first (e.g.
      // `value #>> '{}'`) is a functional expression and forces a
      // sequential scan.
      const bounds = [];
      if (cf.value.start) {
        bounds.push(
          sql`${documentFieldValues.value} >= ${JSON.stringify(cf.value.start)}::jsonb`,
        );
      }
      if (cf.value.end) {
        bounds.push(
          sql`${documentFieldValues.value} <= ${JSON.stringify(cf.value.end)}::jsonb`,
        );
      }
      // Both bounds null → no constraint (filter is effectively
      // inactive); fall back to a tautology so the outer `eq` on
      // `fieldKey` still narrows.
      return bounds.length > 0 ? and(...bounds) : sql`TRUE`;
    }
    if (
      fieldType &&
      TEXT_LIKE_TYPES.has(fieldType) &&
      typeof cf.value === "string" &&
      cf.value.length > 0
    ) {
      // `documentFieldValues.value` is JSONB — `ILIKE` doesn't have a
      // jsonb operator. `#>> '{}'` extracts the value as text (strips
      // outer quotes for JSON primitive strings) so we can substring-
      // match cleanly.
      return sql`${documentFieldValues.value} #>> '{}' ILIKE ${`%${cf.value}%`}`;
    }
    return eq(documentFieldValues.value, cf.value as never);
  })();
  return exists(
    db
      .select({ one: sql`1` })
      .from(documentFieldValues)
      .where(
        and(
          eq(documentFieldValues.documentId, documents.id),
          eq(documentFieldValues.fieldKey, cf.fieldKey),
          valuePredicate,
        ),
      ),
  );
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

  if (params.customFilters && params.customFilters.length > 0) {
    const keys = params.customFilters.map((cf) => cf.fieldKey);
    const defs = await db
      .select({
        key: fieldDefinitions.key,
        type: fieldDefinitions.type,
      })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.teamId, teamId),
          eq(fieldDefinitions.resourceType, "document"),
          inArray(fieldDefinitions.key, keys),
        ),
      );
    const typeByKey = new Map<string, FieldDefinitionType>(
      defs.map((d) => [d.key, d.type]),
    );
    for (const cf of params.customFilters) {
      baseConditions.push(customFilterExists(cf, typeByKey.get(cf.fieldKey)));
    }
  }

  if (params.entityId && params.entityId.length > 0) {
    baseConditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(documentEntities)
          .where(
            and(
              eq(documentEntities.documentId, documents.id),
              inArray(documentEntities.entityId, params.entityId),
            ),
          ),
      ),
    );
  }

  if (params.labelIds && params.labelIds.length > 0) {
    baseConditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(documentLabels)
          .where(
            and(
              eq(documentLabels.documentId, documents.id),
              inArray(documentLabels.labelId, params.labelIds),
            ),
          ),
      ),
    );
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
      fieldValues: {
        columns: { fieldKey: true, value: true },
      },
    },
  });

  const docMap = new Map(docs.map((d) => [d.id, d]));
  const orderedDocs = ids
    .map((id) => docMap.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d);

  return {
    count: totalCount,
    data: await mapDocsToDriveItems(orderedDocs),
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
          fieldValues: { columns: { fieldKey: true, value: true } },
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
        fieldValues: { columns: { fieldKey: true, value: true } },
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
