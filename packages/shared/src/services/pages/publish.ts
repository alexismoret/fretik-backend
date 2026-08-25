import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { pagePublishError, type PageResponse } from "../../schemas/pages";
import { invalidatePublicPageCache } from "./public-cache";
import { serializePage } from "./serialize";
import { refreshPageVectors } from "./vector-refresh";
import { pageVisibilityWhere, type PageRequester } from "./visibility";

/**
 * Publish a page at `/p/<token>`.
 *
 * Two things are frozen, one is not. The DEFINITION is snapshotted into
 * `publishedDefinition`, so later edits never reach anonymous viewers until
 * republished. The DATA is not: the public page queries live records under the
 * OWNER team's scope. That combination — frozen questions, live answers — is
 * the whole point of the feature, and it means the stored filter set is the
 * security boundary (an anonymous viewer can never widen it: the data endpoint
 * accepts declared variable values and nothing else).
 *
 * Publishing an already-published page refreshes the snapshot and keeps the
 * token, so a shared link never breaks on re-publish.
 */
export const publishPage = async (params: {
  pageId: string;
  teamId: string;
  publishedByUserId: string;
  requester?: PageRequester;
}): Promise<PageResponse> => {
  const existing = await db.query.pages.findFirst({
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  const blocker = pagePublishError(existing.definition);
  if (blocker) return throwHttpError(400, badRequest(blocker));

  const [row] = await db
    .update(pages)
    .set({
      publicToken: existing.publicToken ?? Bun.randomUUIDv7(),
      publishedDefinition: existing.definition,
      publishedAt: new Date(),
      publishedByUserId: params.publishedByUserId,
    })
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)))
    .returning();

  if (!row) return throwHttpError(404, notFound("Page"));
  if (row.publicToken) await invalidatePublicPageCache(row.publicToken);
  // The card says whether a page can be handed out as a link.
  void refreshPageVectors(row.id);
  return serializePage(row);
};

/** Revoke the public URL. The token is cleared, so it can never be reused. */
export const unpublishPage = async (params: {
  pageId: string;
  teamId: string;
  requester?: PageRequester;
}): Promise<PageResponse> => {
  const existing = await db.query.pages.findFirst({
    columns: { id: true, publicToken: true },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  const [row] = await db
    .update(pages)
    .set({
      publicToken: null,
      publishedDefinition: null,
      publishedAt: null,
      publishedByUserId: null,
    })
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)))
    .returning();

  if (!row) return throwHttpError(404, notFound("Page"));
  if (existing.publicToken) {
    await invalidatePublicPageCache(existing.publicToken);
  }
  void refreshPageVectors(row.id);
  return serializePage(row);
};
