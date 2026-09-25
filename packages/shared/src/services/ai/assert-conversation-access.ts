import { type ResolvedResource, requireAccess } from "../../authz/access";
import type { Principal } from "../../authz/principal";
import type { AccessLevel } from "../../schemas/access";

/**
 * Refuse a conversation the caller may not open at `level`.
 *
 * A conversation has one of two audiences, and being in its team is neither:
 *   - a CHAT belongs to its participants (`ai_conversation_members`: the
 *     owner has full access, the others take part) — and, when it has been
 *     opened to its team or project, can also be READ there;
 *   - a WORKFLOW RUN has no participants. It is read by whoever may see the
 *     workflow that produced it.
 *
 * Both are the access engine's rules (`authz/resources/conversation.ts`). The
 * surfaces around a conversation — its attachments, the files its agent
 * produced, its approvals — check this rather than the team alone. Reading
 * takes `view`; adding to it (uploading, deleting a file) takes `use`. A
 * conversation of another team, one the caller is not in and one that does not
 * exist all answer 404; a reader who may not write gets a 403 that says why.
 */
export const assertConversationAccess = (params: {
  conversationId: string;
  principal: Principal;
  level: AccessLevel;
}): Promise<ResolvedResource> =>
  requireAccess({
    principal: params.principal,
    type: "conversation",
    id: params.conversationId,
    required: params.level,
    notFoundMessage: "Conversation not found",
  });
