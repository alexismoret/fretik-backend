import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import type { PageResponse } from "../../schemas/pages";
import { ensurePageCompiled } from "./compile";
import { ensurePageDatasetIndexes } from "./ensure-dataset-indexes";
import { serializePage } from "./serialize";
import { refreshPageVectors } from "./vector-refresh";
import {
  getPageVersion,
  trimPageVersions,
  writePageVersion,
  type PageVersionActor,
} from "./versions";
import { pageVisibilityWhere, type PageRequester } from "./visibility";

/**
 * Put a page back into a state it was in.
 *
 * Restoring is a WRITE, not a rewind: it records a new version whose content
 * is the old one. Nothing is erased, so restoring the wrong version is itself
 * undoable — the property that makes people willing to press the button.
 *
 * The stored definition carries no `compiled` (see `versions.ts`), so it is
 * recompiled here. A version that no longer compiles — the runtime moved on
 * under it — is refused rather than saved, exactly as any other write would
 * be: the store never holds code the server could not build.
 */
export const restorePageVersion = async (params: {
  pageId: string;
  teamId: string;
  versionNumber: number;
  actingUserId: string;
  requester?: PageRequester;
  actor?: PageVersionActor;
}): Promise<{ page: PageResponse; restoredFrom: number }> => {
  const existing = await db.query.pages.findFirst({
    columns: { id: true, name: true },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  const version = await getPageVersion({
    pageId: params.pageId,
    teamId: params.teamId,
    versionNumber: params.versionNumber,
  });
  if (!version) return throwHttpError(404, notFound("Page version"));

  let definition;
  try {
    definition = (await ensurePageCompiled(version.definition)).definition;
  } catch {
    return throwHttpError(
      400,
      badRequest(
        `Version ${params.versionNumber} no longer compiles against the current page runtime, so restoring it would leave the page unable to render.`,
      ),
    );
  }

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(pages)
      // The self-heal feed describes code that is no longer there — same
      // reason `updatePage` clears it.
      .set({ definition, runtimeErrors: [] })
      .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)))
      .returning();
    if (!updated) return undefined;

    await writePageVersion(tx, {
      pageId: updated.id,
      teamId: params.teamId,
      name: updated.name,
      operation: "restore",
      definition,
      actor: params.actor ?? { actor: "user", userId: params.actingUserId },
      meta: { restoredFrom: params.versionNumber },
    });
    return updated;
  });

  if (!row) return throwHttpError(404, notFound("Page"));
  ensurePageDatasetIndexes({ definition });
  await trimPageVersions(row.id);
  void refreshPageVectors(row.id);
  return { page: serializePage(row), restoredFrom: params.versionNumber };
};
