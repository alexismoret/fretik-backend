import type { ResolvedResource } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import { resolvePrincipals } from "../../access/sharing/principals";
import { writeShares } from "../../access/sharing/share";
import type { ConversationMember } from "../conversation-serializer";
import { getReadableConversation } from "../get";
import { takingPartCandidates } from "./candidates";

/**
 * Bring colleagues into a conversation as participants — anyone who takes
 * part may (`use`). The ids are narrowed to the real people who may take part
 * — its project's participants when it is in one, else its team's people —
 * and those already seated stay as they are. The seats are the share
 * dialog's, journaled and answering requests to take part the same way
 * (`writeShares`). Returns the refreshed roster.
 */
export const addConversationMembers = async (data: {
  principal: UserPrincipal;
  resource: ResolvedResource;
  userIds: string[];
}): Promise<ConversationMember[]> => {
  const { principal, resource } = data;

  const candidates = await takingPartCandidates(resource.node, data.userIds);
  const grantees = await resolvePrincipals(
    principal.organizationId,
    candidates.map((person) => ({ type: "user" as const, id: person.userId })),
  );
  await writeShares({
    principal,
    node: resource.node,
    type: "conversation",
    grantees: [...grantees.values()],
    level: "use",
  });

  const refreshed = await getReadableConversation({
    resource,
    userId: principal.userId,
  });
  return refreshed?.members ?? [];
};
