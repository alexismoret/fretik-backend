import { getTeamBotUserId } from "../services/auth/bot-user";
import { loadPrincipal } from "./load-principal";
import type { UserPrincipal } from "./principal";

/**
 * A team's agent, as the engine sees it: the principal of the team's bot user
 * (`services/auth/bot-user.ts`), a member of the team like any other. It
 * reaches what the team reaches, and nothing private to one of its people.
 *
 * What reads for a team with no person behind it — an anonymous visitor of a
 * published page — reads as this, never as a system principal: a public link
 * must not become the one door that opens every file of the team.
 *
 * A team without its agent is broken data (`team_settings.bot_user_id` is NOT
 * NULL and the bot cannot leave), so it throws rather than read as nobody.
 */
export const teamAgentPrincipal = async (input: {
  organizationId: string;
  teamId: string;
}): Promise<UserPrincipal> => {
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: await getTeamBotUserId(input.teamId),
  });
  if (!principal) {
    throw new Error(
      `Team ${input.teamId} has no agent in organization ${input.organizationId}`,
    );
  }
  return principal;
};
