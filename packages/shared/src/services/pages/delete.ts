import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deletePinsForTarget } from "../pins/cleanup";
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

  // Pins carry no FK to their target (one column, two possible parents), so the
  // cascade is written by hand — in one tx with the delete, so a rollback
  // leaves the sidebars pointing at the page that survived.
  await db.transaction(async (tx) => {
    await tx
      .delete(pages)
      .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)));
    await deletePinsForTarget({
      targetType: "page",
      targetId: params.pageId,
      tx,
    });
  });

  // Outside the tx: the cache is not transactional, and dropping it a moment
  // after the commit is what "the token stops resolving" means.
  if (existing.publicToken) {
    await invalidatePublicPageCache(existing.publicToken);
  }
};
