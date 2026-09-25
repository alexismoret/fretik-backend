import { loadPrincipal } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import type { LoadedNode } from "../../authz/resources/types";

/**
 * Who reads a chat besides the person writing in it, from the access engine's
 * facts on it (`authz/resources/conversation.ts`): its seats — the owner and
 * the other participants — and whoever may read it without taking part, a
 * person or a group it was given to, or its whole team while it is open.
 *
 * The assistant answers where all of them read. What it gathers by itself —
 * recall, memory, the persistent context — is therefore the writer's own only
 * when nobody else reads the chat; otherwise it is the team's, and in a
 * project the project's (`authz/project-agent.ts`).
 */
export interface ChatAudience {
  /** Someone other than the writer can read the chat. */
  readonly others: boolean;
  /** Someone can read it without taking part: it is open, or given to read. */
  readonly readers: boolean;
}

export const chatAudience = (
  node: LoadedNode,
  writerId: string,
): ChatAudience => {
  // A seat gives `use` or `full`; `view` is only ever a grant to read.
  const readers =
    !node.restricted ||
    node.grants.some(
      (grant) => grant.principalType !== "user" || grant.level === "view",
    );
  const others =
    readers ||
    (node.ownerUserId !== null && node.ownerUserId !== writerId) ||
    node.grants.some((grant) => grant.principalId !== writerId);
  return { others, readers };
};

/**
 * Whether the person writing is one of the chat's team's people. Someone who
 * takes part in a project of another team is not: the assistant answers them
 * in the project's context only, and the team's own (its instructions, files,
 * memory, collections and shared connections) stays out of their turns.
 */
export const worksInTeam = (
  principal: UserPrincipal,
  teamId: string,
): boolean => principal.teamRoles.has(teamId);

/**
 * `worksInTeam` for someone named by id — the person a resumed turn or a
 * workflow run acts for. Someone who has left the organization works in none
 * of its teams.
 */
export const userWorksInTeam = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
}): Promise<boolean> => {
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  return principal !== null && worksInTeam(principal, input.teamId);
};
