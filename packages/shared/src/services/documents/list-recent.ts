import { and, count, eq } from "drizzle-orm";
import {
  DOCUMENT_ACCESS_COLUMNS,
  driveVisibility,
  visibleDocumentsWhere,
} from "../../authz/drive-sql";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { documents } from "../../db/schema";
import type { ParamsList } from "../../schemas/common/params";
import type { RecentDocument } from "../../schemas/documents";

/**
 * The team's most recently added documents the person can open, newest first
 * — powers the home "Recent files" card. A thin projection: only the columns
 * needed to render a file row (name, kind, size, status, when), sorted on the
 * `created_at` index, with the exact total for pagination. No presigned URL /
 * properties (that's the per-document detail route).
 */
export const listRecentDocuments = async (data: {
  principal: Principal;
  teamId: string;
  params: ParamsList;
}): Promise<{ count: number; data: RecentDocument[] }> => {
  const { principal, teamId, params } = data;
  const { limit, page } = params;
  const visibility = await driveVisibility(principal, teamId);

  const [rows, totalRows] = await Promise.all([
    db.query.documents.findMany({
      where: { teamId, ...visibleDocumentsWhere(visibility) },
      orderBy: { createdAt: "desc" },
      limit,
      offset: page * limit,
      columns: {
        id: true,
        originalFilename: true,
        mimeType: true,
        fileSize: true,
        status: true,
        folderId: true,
        createdAt: true,
      },
    }),
    db
      .select({ count: count() })
      .from(documents)
      .where(
        and(
          eq(documents.teamId, teamId),
          visibility.document(DOCUMENT_ACCESS_COLUMNS),
        ),
      ),
  ]);

  return { count: totalRows[0]?.count ?? 0, data: rows };
};
