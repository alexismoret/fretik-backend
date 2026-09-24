import type { Principal } from "../../authz/principal";
import db from "../../db";
import { notFound, throwHttpError } from "../../lib/errors";
import type { AccessLevel } from "../../schemas/access";
import type { PageResponse, PageSummary } from "../../schemas/pages";
import { serializePage, serializePageSummary } from "./serialize";
import { pageAccessWhere } from "./visibility";

/**
 * List a team's pages the principal can see, newest-touched first — the
 * engine decides (`visibility.ts`), so a restricted page appears only to its
 * owner and the people it is shared with.
 *
 * Archived pages are in no listing, for anyone: that is what archiving is (see
 * `pages.archivedAt`). They stay reachable by id, so a link to one still opens
 * it — `getPage` deliberately does not filter.
 */
export const listPages = async (params: {
  teamId: string;
  principal: Principal;
  limit?: number;
  /** Only the pages this conversation built (their provenance). */
  sourceConversationId?: string;
  /** Only this project's pages; the team's and its projects' when omitted. */
  projectId?: string;
}): Promise<PageSummary[]> => {
  const rows = await db.query.pages.findMany({
    where: {
      teamId: params.teamId,
      archivedAt: { isNull: true },
      ...pageAccessWhere(params.principal, "view"),
      ...(params.sourceConversationId === undefined
        ? {}
        : { sourceConversationId: params.sourceConversationId }),
      ...(params.projectId === undefined
        ? {}
        : { projectId: params.projectId }),
    },
    orderBy: { updatedAt: "desc" },
    limit: params.limit ?? 100,
  });
  return rows.map(serializePageSummary);
};

/**
 * Fetch one page of its team; 404 when missing or not visible at `level`
 * (`view` unless the caller is about to do more with it).
 */
export const getPage = async (params: {
  pageId: string;
  teamId: string;
  principal: Principal;
  level?: AccessLevel;
}): Promise<PageResponse> => {
  const row = await db.query.pages.findFirst({
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageAccessWhere(params.principal, params.level ?? "view"),
    },
  });
  if (!row) return throwHttpError(404, notFound("Page"));
  return serializePage(row);
};
