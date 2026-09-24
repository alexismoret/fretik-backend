import { decideAllCapabilities } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import type { TeamDetail } from "../../schemas/teams";
import { getTeamAccessPolicy } from "../organization/access-policy";
import { findOrganizationTeam } from "./find";
import { listTeamRoster } from "./roster";

/**
 * One team of the principal's organization: its people, its defaults, and what
 * the principal may do in it.
 */
export const getTeamDetail = async (input: {
  principal: UserPrincipal;
  teamId: string;
}): Promise<TeamDetail> => {
  const found = await findOrganizationTeam(input.principal, input.teamId);
  const [members, policy, capabilities] = await Promise.all([
    listTeamRoster(found.id),
    getTeamAccessPolicy(found.id),
    decideAllCapabilities({ principal: input.principal, teamId: found.id }),
  ]);
  return {
    ...found,
    memberCount: members.length,
    role: input.principal.teamRoles.get(found.id) ?? null,
    members,
    policy,
    capabilities,
  };
};
