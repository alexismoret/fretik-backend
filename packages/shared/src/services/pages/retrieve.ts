import db from "../../db";
import { notFound, throwHttpError } from "../../lib/errors";
import type { PageResponse, PageSummary } from "../../schemas/pages";
import { serializePage, serializePageSummary } from "./serialize";
import { pageVisibilityWhere, type PageRequester } from "./visibility";

/**
 * List a team's pages, newest-touched first. Private pages (`userId` set) are
 * filtered out for everyone but their owner and org admins — omit `requester`
 * for system-trust callers.
 */
export const listPages = async (params: {
  teamId: string;
  requester?: PageRequester;
  limit?: number;
}): Promise<PageSummary[]> => {
  const rows = await db.query.pages.findMany({
    where: {
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
    orderBy: { updatedAt: "desc" },
    limit: params.limit ?? 100,
  });
  return rows.map(serializePageSummary);
};

/** Fetch one page in the team's scope; 404 when missing or not visible. */
export const getPage = async (params: {
  pageId: string;
  teamId: string;
  requester?: PageRequester;
}): Promise<PageResponse> => {
  const row = await db.query.pages.findFirst({
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!row) return throwHttpError(404, notFound("Page"));
  return serializePage(row);
};
