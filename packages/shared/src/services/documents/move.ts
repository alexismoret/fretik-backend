import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { documents, folders } from "../../db/schema";
import { labelFilingOnMoves } from "../folders/label-filing-move";

/** Why one requested document was not moved. */
export interface MoveDocumentsFailure {
  documentId: string;
  reason: "not_found";
}

export interface MoveDocumentsResult {
  /** Documents whose folder changed. */
  moved: { id: string; filename: string }[];
  /** Already in the destination: nothing to do, and not a failure. */
  unchanged: string[];
  failed: MoveDocumentsFailure[];
}

/**
 * Move MANY documents into one folder (`null` = the Drive root), set-based.
 *
 * The bulk sibling of the move branch of `updateDocument`, which costs one
 * transaction per document. Tidying a Drive is hundreds of moves; here it is
 * one read, one transaction holding one UPDATE plus one counter write per
 * source folder, and the filing labels.
 *
 * Throws 404-shaped only for the DESTINATION (an unknown folder must not
 * silently point documents at nothing). An id that is not one of this team's
 * documents is reported in `failed`, never thrown: one stale id must not cost
 * the other hundred.
 *
 * What it deliberately does NOT do, unlike `updateDocument`:
 *  - No vector refresh. The indexed metadata (`buildDocumentVectorMetadata`)
 *    carries the filename, summary, language, fields and mentions, and no
 *    folder, so a move changes nothing an embedding holds. `updateDocument`
 *    schedules one anyway, which is a full re-vectorisation per document;
 *    on a bulk move that would be hundreds of enrichment passes for nothing.
 *  - No `document:{id}` cache invalidation. Nothing writes that prefix any
 *    more, and `deleteKeysByPrefix` is a SCAN of the whole keyspace, so doing
 *    it per document would make a 200-document move 200 full scans.
 */
export const moveDocuments = async (params: {
  ids: readonly string[];
  teamId: string;
  folderId: string | null;
}): Promise<MoveDocumentsResult> => {
  const { teamId, folderId } = params;
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) return { moved: [], unchanged: [], failed: [] };

  if (folderId !== null) {
    const destination = await db.query.folders.findFirst({
      columns: { id: true },
      where: { id: folderId, teamId },
    });
    if (!destination) {
      throw new Error(`Folder ${folderId} not found for this team.`);
    }
  }

  const existing = await db.query.documents.findMany({
    columns: { id: true, folderId: true, originalFilename: true },
    where: { id: { in: ids }, teamId },
  });
  const byId = new Map(existing.map((d) => [d.id, d]));

  const failed: MoveDocumentsFailure[] = ids
    .filter((id) => !byId.has(id))
    .map((documentId) => ({ documentId, reason: "not_found" as const }));
  const unchanged = existing
    .filter((d) => d.folderId === folderId)
    .map((d) => d.id);
  const toMove = existing.filter((d) => d.folderId !== folderId);
  if (toMove.length === 0) return { moved: [], unchanged, failed };

  // The rows and the counters together, as `updateDocument` does: the
  // counters order the filing candidates and gate the nightly describe pass,
  // so a failure between the two would skew both for good.
  const movedIds = await db.transaction(async (tx) => {
    // `folderId` re-checked in the WHERE: a document someone moved between
    // the read and here keeps the place that person chose, and is simply not
    // counted, so the counters match what actually moved.
    const rows = await tx
      .update(documents)
      .set({ folderId })
      .where(
        and(
          inArray(
            documents.id,
            toMove.map((d) => d.id),
          ),
          eq(documents.teamId, teamId),
          folderId === null
            ? sql`${documents.folderId} IS NOT NULL`
            : sql`${documents.folderId} IS DISTINCT FROM ${folderId}`,
        ),
      )
      .returning({ id: documents.id });
    const moved = new Set(rows.map((r) => r.id));

    // Counted from what the UPDATE returned, not from the earlier read.
    const leaving = new Map<string, number>();
    for (const doc of toMove) {
      if (moved.has(doc.id) && doc.folderId !== null) {
        leaving.set(doc.folderId, (leaving.get(doc.folderId) ?? 0) + 1);
      }
    }
    // Sequential, NOT Promise.all: a transaction holds one pg connection.
    for (const [sourceId, count] of leaving) {
      // eslint-disable-next-line no-await-in-loop
      await tx
        .update(folders)
        .set({ documentCount: sql`${folders.documentCount} - ${count}` })
        .where(eq(folders.id, sourceId));
    }
    if (folderId !== null && moved.size > 0) {
      await tx
        .update(folders)
        .set({ documentCount: sql`${folders.documentCount} + ${moved.size}` })
        .where(eq(folders.id, folderId));
    }
    return moved;
  });

  const moved = toMove
    .filter((d) => movedIds.has(d.id))
    .map((d) => ({ id: d.id, filename: d.originalFilename }));

  // A placement is the answer to any filing decision made about these
  // documents, exactly as for a single move. Best-effort by contract.
  await labelFilingOnMoves({
    teamId,
    documentIds: moved.map((d) => d.id),
    toFolderId: folderId,
  });

  return { moved, unchanged, failed };
};
