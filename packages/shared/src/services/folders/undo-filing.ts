import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import { documents, folders } from "../../db/schema";
import { alreadyExists, notFound, throwHttpError } from "../../lib/errors";
import { deleteKeysByPrefix } from "../../lib/redis";
import { labelDecisions } from "../decisions/journal";
import { FILING_POINT, ROOT_OPTION } from "./auto-file";
import { findAutoFiling } from "./list-auto-filed";

/**
 * Put an auto-filed document back at the root.
 *
 * The one-click correction for the filer, and a label in the same gesture:
 * a person undoing a filing is saying "none of these folders", which is the
 * strongest evidence the filer can get that its bar let a wrong answer
 * through.
 *
 * Guarded like the filing itself: the document moves back only if it is
 * STILL in the folder the filer chose. Moved since, it is a person's
 * placement, and undoing the filer must not undo them.
 */
export const undoAutoFiling = async (params: {
  documentId: string;
  teamId: string;
  userId: string;
}): Promise<{ id: string; folderId: null }> => {
  const filing = await findAutoFiling(params);
  if (!filing) return throwHttpError(404, notFound("Automatic filing"));

  const undone = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(documents)
      .set({ folderId: null })
      .where(
        and(
          eq(documents.id, params.documentId),
          eq(documents.teamId, params.teamId),
          eq(documents.folderId, filing.folderId),
        ),
      )
      .returning({ id: documents.id });
    if (!row) return false;
    await tx
      .update(folders)
      .set({ documentCount: sql`${folders.documentCount} - 1` })
      .where(eq(folders.id, filing.folderId));
    return true;
  });
  if (!undone) {
    return throwHttpError(
      409,
      alreadyExists("This document has been moved since it was filed."),
    );
  }

  await deleteKeysByPrefix(`document:${params.documentId}`);
  await labelDecisions({
    teamId: params.teamId,
    point: FILING_POINT,
    subjectId: params.documentId,
    label: ROOT_OPTION,
    source: "filing_undone",
    userId: params.userId,
  });
  return { id: params.documentId, folderId: null };
};
