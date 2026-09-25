import { requireCapability } from "../../../authz/gates";
import type { UserPrincipal } from "../../../authz/principal";
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
 * An answer to "this tool only reads?". Accepting sets the tool to run
 * without approval (the override its governor could set by hand) and labels
 * the suggestion right; rejecting changes no permission and labels it wrong,
 * which also hides it. Same rule as editing the policies, for both answers
 * (a rejection hides the suggestion from everyone): a shared connection's
 * permissions take `team.settings.manage`, a personal one is its owner's.
 */
export const answerReadOnlySuggestion = async (params: {
  connectionId: string;
  teamId: string;
  principal: UserPrincipal;
  actionName: string;
  accept: boolean;
}): Promise<ExternalAppConnection> => {
  const { principal } = params;
  const connection = await getConnectionForCaller(
    params.connectionId,
    params.teamId,
    principal.userId,
  );
  if (connection.userId === null) {
    await requireCapability({
      principal,
      capability: "team.settings.manage",
      teamId: params.teamId,
      message: "Only a team lead can change a team connection's permissions.",
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
        principal,
        actionPolicies: { [params.actionName]: "auto" },
      })
    : connection;
  await labelDecisions({
    teamId: connection.teamId,
    point: SUGGEST_KIND_POINT,
    subjectId: snapshot.id,
    questionId: kindJournalId(params.actionName),
    label: params.accept ? "read" : REJECTED_LABEL,
    source: "manual",
    userId: principal.userId,
  });
  return updated;
};
