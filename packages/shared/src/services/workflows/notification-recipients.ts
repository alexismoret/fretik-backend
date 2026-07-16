import db from "../../db";
import type { WorkflowNotifications } from "../../schemas/workflows";
import { filterTeamMemberIds } from "../team/members";

export interface RunEmailRecipient {
  email: string;
  name: string;
  language: string;
}

/**
 * Resolve who actually receives a run's notification emails — the SINGLE
 * place the recipient rule lives, shared by the completion and approval
 * senders.
 *
 * Effective ids = `recipientUserIds` ∪ the run's trigger actor (when
 * `notifyTriggeredBy`), deduplicated, then re-intersected with the CURRENT
 * team roster (`filterTeamMemberIds` — drops departed members, out-of-team
 * form submitters, and the bot). Run content never leaves the team, however
 * stale the stored config is.
 */
export const resolveRunNotificationRecipients = async (params: {
  teamId: string;
  notifications: WorkflowNotifications;
  triggeredByUserId: string | null;
}): Promise<RunEmailRecipient[]> => {
  const requested = new Set(params.notifications.recipientUserIds);
  if (params.notifications.notifyTriggeredBy && params.triggeredByUserId) {
    requested.add(params.triggeredByUserId);
  }
  if (requested.size === 0) return [];

  const memberIds = await filterTeamMemberIds(params.teamId, [...requested]);
  if (memberIds.length === 0) return [];

  const users = await db.query.user.findMany({
    where: { id: { in: memberIds } },
    columns: { email: true, name: true, language: true },
  });
  return users.filter((u) => Boolean(u.email));
};
