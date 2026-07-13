import { count, eq } from "drizzle-orm";
import db from "../../db";
import { documents } from "../../db/schema";
import type { ParamsList } from "../../schemas/common/params";
import type { RecentDocument } from "../../schemas/documents";

/**
 * The team's most recently added documents, newest first — powers the home
 * "Recent files" card. A thin projection: only the columns needed to render a
 * file row (name, kind, size, status, when), sorted on the `created_at` index,
 * with the exact total for pagination. No presigned URL / properties (that's
 * the per-document detail route).
 */
export const listRecentDocuments = async (data: {
  teamId: string;
  params: ParamsList;
}): Promise<{ count: number; data: RecentDocument[] }> => {
  const { teamId, params } = data;
  const { limit, page } = params;

  const [rows, totalRows] = await Promise.all([
    db.query.documents.findMany({
      where: { teamId },
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
      .where(eq(documents.teamId, teamId)),
  ]);

  return { count: totalRows[0]?.count ?? 0, data: rows };
};
