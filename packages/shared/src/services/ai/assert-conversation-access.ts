import db from "../../db";
import { notFound, throwHttpError } from "../../lib/errors";
import { isOrgAdmin } from "../organization/member-role";
import { workflowVisibilityWhere } from "../workflows/visibility";

/**
 * Refuse (404) a conversation the caller may not open.
 *
 * A conversation has one of two audiences, and being in its team is neither:
 *   - a CHAT belongs to its participants (`ai_conversation_members`). A solo
 *     chat is private to its author even from their teammates;
 *   - a WORKFLOW RUN has no participants. It belongs to whoever may see the
 *     workflow that produced it — the same rule as the run's own routes
 *     (`workflowVisibilityWhere`: team-shared, its owner, or an org admin).
 *
 * The surfaces around a conversation — its attachments, the files its agent
 * produced — check this rather than the team alone. 404 in every refusal: a
 * conversation of another team, one the caller is not in, and one that does
 * not exist must read the same.
 */
export const assertConversationAccess = async (params: {
  conversationId: string;
  teamId: string;
  organizationId: string;
  userId: string;
}): Promise<void> => {
  const { conversationId, teamId, userId } = params;
  const refuse = (): never =>
    throwHttpError(404, notFound("Conversation not found"));

  const conversation = await db.query.aiConversations.findFirst({
    columns: { agentType: true },
    where: { id: conversationId, teamId },
  });
  if (!conversation) return refuse();

  if (conversation.agentType === "workflow") {
    const run = await db.query.workflowRuns.findFirst({
      columns: { id: true },
      where: {
        conversationId,
        teamId,
        workflow: workflowVisibilityWhere({
          userId,
          isAdmin: await isOrgAdmin(params.organizationId, userId),
        }),
      },
    });
    if (!run) return refuse();
    return;
  }

  const membership = await db.query.aiConversationMembers.findFirst({
    columns: { id: true },
    where: { conversationId, userId },
  });
  if (!membership) return refuse();
};
