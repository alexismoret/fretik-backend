import {
  labelDecisions,
  labelDecisionsForSubjects,
} from "../decisions/journal";
import { FILING_POINT, ROOT_OPTION } from "./auto-file";

/**
 * A person moved a document: if the filer ever decided about it, this says
 * where it actually belongs.
 *
 * It labels BOTH kinds of filing decision, and the second is the valuable
 * one. A document the filer moved and a person moved again says the filer
 * was wrong. A document the filer LEFT at the root and a person then filed
 * says whether the filer's first choice was right after all — the only
 * evidence there is on whether its confidence bar is set too high.
 *
 * An inference, not an explicit act: it fills an empty label and never
 * overwrites one (see `LabelSource`). Best-effort, never throws.
 */
export const labelFilingOnMove = async (params: {
  teamId: string;
  documentId: string;
  toFolderId: string | null;
}): Promise<void> => {
  await labelDecisions({
    teamId: params.teamId,
    point: FILING_POINT,
    subjectId: params.documentId,
    label: params.toFolderId ?? ROOT_OPTION,
    source: "document_moved",
  });
};

/** `labelFilingOnMove` for many documents placed in the same folder at once. */
export const labelFilingOnMoves = async (params: {
  teamId: string;
  documentIds: readonly string[];
  toFolderId: string | null;
}): Promise<void> => {
  if (params.documentIds.length === 0) return;
  await labelDecisionsForSubjects({
    teamId: params.teamId,
    point: FILING_POINT,
    subjectIds: params.documentIds,
    label: params.toFolderId ?? ROOT_OPTION,
    source: "document_moved",
  });
};
