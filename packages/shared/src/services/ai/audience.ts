import type { LoadedNode } from "../../authz/resources/types";

/**
 * Who reads a chat besides the person writing in it, from the access engine's
 * facts on it (`authz/resources/conversation.ts`): its seats — the owner and
 * the other participants — and whoever may read it without taking part, a
 * person or a group it was given to, or its whole team while it is open.
 *
 * The assistant answers where all of them read. What it gathers by itself —
 * recall, memory, the persistent context — is therefore the writer's own only
 * when nobody else reads the chat; otherwise it is the team's.
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
