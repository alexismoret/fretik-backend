import { decideAllCapabilities } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import type { AccessMe } from "../../schemas/access-api";

/**
 * Who the caller is to the access engine, and every capability decided for
 * them in their active team: what the app reads to show, hide or lock an
 * action, so it never re-derives a rule. It says nothing about anyone else.
 */
export const describeAccess = async (input: {
  principal: UserPrincipal;
  activeTeamId: string | null;
}): Promise<AccessMe> => {
  const { principal, activeTeamId } = input;
  return {
    userId: principal.userId,
    organizationId: principal.organizationId,
    orgRole: principal.orgRole,
    isOrgAdmin: principal.isOrgAdmin,
    isGuest: principal.isGuest,
    teams: [...principal.teamRoles].map(([teamId, role]) => ({ teamId, role })),
    activeTeamId,
    capabilities: await decideAllCapabilities({
      principal,
      teamId: activeTeamId,
    }),
  };
};
