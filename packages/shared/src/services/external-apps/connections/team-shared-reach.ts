import { isTeamMember } from "../../team/members";

/**
 * Whether someone may use the connections a team shares: only its own
 * people (its agent included) may.
 *
 * Someone who takes part in a project of the team from another team works
 * with the project, never with the accounts the team connected (its shared
 * mailbox, its CRM). The assistant acting for them lists none of those, and
 * running one is refused wherever the request comes from: the prompt, the
 * sandbox, an approval granted later. Their own connections in the team, if
 * any, stay theirs.
 */
export const reachesTeamSharedConnections = (
  teamId: string,
  userId: string,
): Promise<boolean> => isTeamMember(teamId, userId);
