import type { ResolvedResource } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import { throwNotVisible } from "../../../authz/refusals";
import { resolvePrincipals } from "../../access/sharing/principals";
import { writeShares } from "../../access/sharing/share";
import { filterTeamMemberIds } from "../../team/members";
import type { ConversationMember } from "../conversation-serializer";
import { getReadableConversation } from "../get";

/**
 * Bring colleagues into a conversation as participants — anyone who takes
 * part may (`use`). The ids are narrowed to real, non-bot people of the
 * conversation's team, since taking part is only for them; those already
 * seated stay as they are. The seats are the share dialog's, journaled and
 * answering requests to take part the same way (`writeShares`). Returns the
 * refreshed roster.
 */
export const addConversationMembers = async (data: {
  principal: UserPrincipal;
  resource: ResolvedResource;
  userIds: string[];
}): Promise<ConversationMember[]> => {
  const { principal, resource } = data;
  const teamId =
    resource.node.teamId ?? throwNotVisible("Conversation not found");

  const validIds = await filterTeamMemberIds(teamId, data.userIds);
  const grantees = await resolvePrincipals(
    principal.organizationId,
    validIds.map((id) => ({ type: "user" as const, id })),
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
