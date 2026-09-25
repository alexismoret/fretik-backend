import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { decisionLog } from "../../db/schema";
import type { AutoFiled } from "../../schemas/folders";
import { FILING_POINT } from "./auto-file";

/**
 * The filer's last filing of one document: the decision and the folder it
 * chose. Null when the filer never moved it. Whether the document is STILL
 * there is the caller's guard to apply, in its own write.
 */
export const findAutoFiling = async (params: {
  documentId: string;
  teamId: string;
}): Promise<{ decisionId: string; folderId: string } | null> => {
  const [row] = await db
    .select({ id: decisionLog.id, targetId: decisionLog.targetId })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.teamId, params.teamId),
        eq(decisionLog.point, FILING_POINT),
        eq(decisionLog.subjectId, params.documentId),
        eq(decisionLog.outcome, "filed"),
      ),
    )
    .orderBy(desc(decisionLog.createdAt))
    .limit(1);
  if (!row || row.targetId === null) return null;
  return { decisionId: row.id, folderId: row.targetId };
};

/**
 * Which of these documents sit where the filer put them.
 *
 * A document counts as auto-filed while it is still IN the folder the filer
 * chose and nobody has said otherwise. Moved elsewhere, or labelled with a
 * different answer, it is simply a document: the chip that offers to undo a
 * filing must not appear on a document a person has since placed.
 */
export const listAutoFiled = async (params: {
  teamId: string;
  documents: readonly { id: string; folderId: string | null }[];
}): Promise<Map<string, AutoFiled>> => {
  const placed = params.documents.filter(
    (d): d is { id: string; folderId: string } => d.folderId !== null,
  );
  if (placed.length === 0) return new Map();

  const rows = await db
    .select({
      id: decisionLog.id,
      subjectId: decisionLog.subjectId,
      targetId: decisionLog.targetId,
      confidence: decisionLog.confidence,
      label: decisionLog.label,
      createdAt: decisionLog.createdAt,
    })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.teamId, params.teamId),
        eq(decisionLog.point, FILING_POINT),
        eq(decisionLog.outcome, "filed"),
        inArray(
          decisionLog.subjectId,
          placed.map((d) => d.id),
        ),
      ),
    );

  const folderOf = new Map(placed.map((d) => [d.id, d.folderId]));
  const result = new Map<string, AutoFiled>();
  for (const row of rows) {
    const folderId = folderOf.get(row.subjectId);
    if (row.targetId === null || row.targetId !== folderId) continue;
    if (row.label !== null && row.label !== folderId) continue;
    result.set(row.subjectId, {
      decisionId: row.id,
      confidence: row.confidence,
      filedAt: row.createdAt,
      confirmed: row.label === folderId,
    });
  }
  return result;
};
