import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import type {
  TeamAccessPolicy,
  TeamAccessPolicyPatch,
} from "../../schemas/access-policy";
import { setTeamAccessPolicy } from "../organization/access-policy";
import { findOrganizationTeam } from "./find";

/**
 * Change a team's access defaults — today, what a member (not a lead, not a
 * viewer) gets on the team's content. The team's leads decide, and the
 * organization's admins (`team.manage`).
 */
export const setTeamPolicy = async (input: {
  principal: UserPrincipal;
  teamId: string;
  patch: TeamAccessPolicyPatch;
}): Promise<TeamAccessPolicy> => {
  const { principal } = input;
  const found = await findOrganizationTeam(principal, input.teamId);
  await requireCapability({
    principal,
    capability: "team.manage",
    teamId: found.id,
  });
  return setTeamAccessPolicy({
    teamId: found.id,
    organizationId: principal.organizationId,
    patch: input.patch,
    actorUserId: principal.userId,
    teamName: found.name,
  });
};
