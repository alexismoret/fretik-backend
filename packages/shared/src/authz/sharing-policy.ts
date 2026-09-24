import { requireCapability } from "./gates";
import type { Principal } from "./principal";

/**
 * The capabilities that govern WHERE something can be shared, whatever the
 * resource: beyond one's own team (`share.cross_team`) and to the whole
 * organization at once (`share.organization`). Having full access to a
 * resource lets a person share it; these say how far.
 *
 * Every share path calls this with the audience it is about to write — the
 * generic share dialog and the older collection sharing alike — so turning a
 * policy off closes every door at once.
 */
export const requireSharingAudience = async (input: {
  principal: Principal;
  /** The team that holds the resource: sharing inside it is always allowed. */
  resourceTeamId: string | null;
  /** The audience about to be written. */
  audience: {
    organization: boolean;
    /** Teams other than the resource's, and people outside it. */
    beyondTeam: boolean;
  };
}): Promise<void> => {
  if (input.audience.organization) {
    await requireCapability({
      principal: input.principal,
      capability: "share.organization",
    });
  }
  if (input.audience.beyondTeam) {
    await requireCapability({
      principal: input.principal,
      capability: "share.cross_team",
      teamId: input.resourceTeamId,
    });
  }
};
