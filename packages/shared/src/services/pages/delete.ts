import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { invalidatePublicPageCache } from "./public-cache";
import { pageVisibilityWhere, type PageRequester } from "./visibility";

/** Delete a page. Its shares cascade; a published token stops resolving. */
export const deletePage = async (params: {
  pageId: string;
  teamId: string;
  requester?: PageRequester;
}): Promise<void> => {
  const existing = await db.query.pages.findFirst({
    columns: { id: true, publicToken: true },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  await db
    .delete(pages)
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)));

  if (existing.publicToken) {
    await invalidatePublicPageCache(existing.publicToken);
  }
};
