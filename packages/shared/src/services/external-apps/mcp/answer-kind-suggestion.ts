import type { ExternalAppConnection } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { labelDecisions } from "../../decisions/journal";
import { getConnectionForCaller } from "../connections/get-by-id";
import { updateConnection } from "../connections/update";
import { listReadOnlySuggestions } from "./list-kind-suggestions";
import { getSnapshotForConnection } from "./snapshot-store";
import { kindJournalId, SUGGEST_KIND_POINT } from "./suggest-kinds";

/**
 * A rejection says the suggestion was wrong without saying which kind is
 * right. Calibration counts a label that differs from the choice as a miss,
 * which is all a rejection knows.
 */
export const REJECTED_LABEL = "rejected";

/**
 * An admin's answer to "this tool only reads?". Accepting sets the tool to
 * run without approval (the override an admin could set by hand) and labels
 * the suggestion right; rejecting changes no permission and labels it wrong,
 * which also hides it. Same permission rule as editing the policies: on a
 * team connection, admins only.
 */
export const answerReadOnlySuggestion = async (params: {
  connectionId: string;
  teamId: string;
  userId: string;
  actionName: string;
  accept: boolean;
  isOrgAdmin: boolean;
}): Promise<ExternalAppConnection> => {
  const connection = await getConnectionForCaller(
    params.connectionId,
    params.teamId,
    params.userId,
  );
  if (connection.userId === null && !params.isOrgAdmin) {
    return throwHttpError(403, {
      code: ERROR_CODES.FORBIDDEN,
      message: "Only an admin can change a team connection's permissions.",
    });
  }
  const snapshot = await getSnapshotForConnection(connection);
  const suggested =
    snapshot === undefined
      ? new Set<string>()
      : await listReadOnlySuggestions({
          teamId: connection.teamId,
          snapshotId: snapshot.id,
        });
  if (snapshot === undefined || !suggested.has(params.actionName)) {
    return throwHttpError(404, {
      code: ERROR_CODES.NOT_FOUND,
      message: `No pending suggestion for "${params.actionName}".`,
    });
  }

  const updated = params.accept
    ? await updateConnection({
        id: connection.id,
        teamId: params.teamId,
        userId: params.userId,
        actionPolicies: { [params.actionName]: "auto" },
        isOrgAdmin: params.isOrgAdmin,
      })
    : connection;
  await labelDecisions({
    teamId: connection.teamId,
    point: SUGGEST_KIND_POINT,
    subjectId: snapshot.id,
    questionId: kindJournalId(params.actionName),
    label: params.accept ? "read" : REJECTED_LABEL,
    source: "manual",
    userId: params.userId,
  });
  return updated;
};
