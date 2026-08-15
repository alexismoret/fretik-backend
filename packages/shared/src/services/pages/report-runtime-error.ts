import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  PAGE_RUNTIME_ERRORS_KEPT,
  type PageRuntimeError,
  type ReportPageErrorRequest,
} from "../../schemas/pages";
import { pageVisibilityWhere, type PageRequester } from "./visibility";

/**
 * Append one runtime error the sandboxed page reported through the bridge.
 * Keeps a ring buffer of the last N — the agent's self-heal feed, surfaced by
 * managePage `get`/`update`.
 *
 * Plain read-modify-write: two errors racing can drop one entry, which an
 * error FEED tolerates (the SDK already dedupes per message per 5 s, so the
 * buffer's job is recency, not completeness).
 */
export const appendPageRuntimeError = async (params: {
  pageId: string;
  teamId: string;
  requester?: PageRequester;
  report: ReportPageErrorRequest;
}): Promise<void> => {
  const existing = await db.query.pages.findFirst({
    columns: { id: true, runtimeErrors: true },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  const entry: PageRuntimeError = {
    message: params.report.message,
    ...(params.report.stack ? { stack: params.report.stack } : {}),
    ...(params.report.source ? { source: params.report.source } : {}),
    at: new Date().toISOString(),
  };
  const runtimeErrors = [...existing.runtimeErrors, entry].slice(
    -PAGE_RUNTIME_ERRORS_KEPT,
  );

  await db
    .update(pages)
    .set({ runtimeErrors })
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)));
};

/** Clear the feed — called on every successful v3 code write, so the tail the
 * agent reads is always about the CURRENT code, never the one it just fixed. */
export const clearPageRuntimeErrors = async (params: {
  pageId: string;
  teamId: string;
}): Promise<void> => {
  await db
    .update(pages)
    .set({ runtimeErrors: [] })
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)));
};
