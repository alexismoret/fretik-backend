import { and, eq, isNull, or } from "drizzle-orm";
import db from "../../../db";
import { decisionLog } from "../../../db/schema";
import { SUGGEST_KIND_POINT } from "./suggest-kinds";

const JOURNAL_PREFIX = "kind:";

/**
 * The tools of one snapshot the decision model thinks only read, by action
 * name — the suggestions an admin still has to answer.
 *
 * Only `read` is surfaced: it is the one suggestion that changes something
 * an admin would act on (lifting the approval gate every un-annotated tool
 * gets). A rejected suggestion is labelled and stays hidden; an accepted one
 * is hidden by the override it set.
 */
export const listReadOnlySuggestions = async (params: {
  teamId: string;
  snapshotId: string;
}): Promise<Set<string>> => {
  const rows = await db
    .select({ questionId: decisionLog.questionId })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.teamId, params.teamId),
        eq(decisionLog.point, SUGGEST_KIND_POINT),
        eq(decisionLog.subjectId, params.snapshotId),
        eq(decisionLog.outcome, "suggested"),
        eq(decisionLog.choice, "read"),
        or(isNull(decisionLog.label), eq(decisionLog.label, "read")),
      ),
    );
  return new Set(
    rows
      .filter((row) => row.questionId.startsWith(JOURNAL_PREFIX))
      .map((row) => row.questionId.slice(JOURNAL_PREFIX.length)),
  );
};
