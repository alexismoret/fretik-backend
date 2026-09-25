import db from "../../db";
import { alreadyExists, notFound, throwHttpError } from "../../lib/errors";
import { labelDecisions } from "../decisions/journal";
import { FILING_POINT } from "./auto-file";
import { findAutoFiling } from "./list-auto-filed";

/**
 * "That's the right folder."
 *
 * Nothing moves: it only records the answer, so the filing counts as correct
 * in calibration and the chip stops asking. Refused once the document has
 * left the folder the filer chose, since a confirmation of a placement that
 * no longer exists would label the wrong answer as right.
 */
export const confirmAutoFiling = async (params: {
  documentId: string;
  teamId: string;
  userId: string;
}): Promise<{ id: string; folderId: string }> => {
  const filing = await findAutoFiling(params);
  if (!filing) return throwHttpError(404, notFound("Automatic filing"));

  const document = await db.query.documents.findFirst({
    where: { id: params.documentId, teamId: params.teamId },
    columns: { folderId: true },
  });
  if (!document) return throwHttpError(404, notFound("Document"));
  if (document.folderId !== filing.folderId) {
    return throwHttpError(
      409,
      alreadyExists("This document has been moved since it was filed."),
    );
  }

  await labelDecisions({
    teamId: params.teamId,
    point: FILING_POINT,
    subjectId: params.documentId,
    label: filing.folderId,
    source: "manual",
    userId: params.userId,
  });
  return { id: params.documentId, folderId: filing.folderId };
};
