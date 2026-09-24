import db from "../../db";
import type { ToolApprovalRequest } from "../../db/schema";
import { forbidden, throwHttpError } from "../../lib/errors";
import { assertConversationAccess } from "../ai/assert-conversation-access";

/**
 * Who may see an approval, and who may decide it.
 *
 * `getApprovalForCaller` scopes an approval to the team, which is where it
 * lives, but not who it concerns. Two facts decide that:
 *
 *   - An approval is raised INSIDE a conversation — a chat or a workflow run —
 *     and shows what the agent is about to do there (recipients, message
 *     bodies, record values). Seeing it takes the right to open that
 *     conversation: its participants, or whoever may see the workflow.
 *
 *   - A granted approval EXECUTES AS its requester (`approval.userId`): the
 *     plan resolves that person's connections, personal ones included. So when
 *     the requester is a person, deciding is theirs alone — a teammate granting
 *     it would be acting through someone else's mailbox. When the requester is
 *     the team's own identity (the bot a team-shared workflow runs as), the
 *     action runs with team resources only and any member who can see the run
 *     may decide, which is what monitoring a team workflow requires.
 */

type Caller = { userId: string; organizationId: string };

/** Refuse (404) an approval the caller may not see. */
export const assertCanViewApproval = async (
  approval: ToolApprovalRequest,
  caller: Caller,
): Promise<void> => {
  await assertConversationAccess({
    conversationId: approval.conversationId,
    teamId: approval.teamId,
    organizationId: caller.organizationId,
    userId: caller.userId,
  });
};

/**
 * Whether `userId` may decide an approval they can see: they requested it, or
 * it runs as the team's own identity. Does not check visibility — pair it with
 * `assertCanViewApproval`, or use `assertCanDecideApproval`.
 */
export const isApprovalDecidableBy = async (
  approval: ToolApprovalRequest,
  userId: string,
): Promise<boolean> => {
  if (approval.userId === userId) return true;
  const settings = await db.query.teamSettings.findFirst({
    columns: { botUserId: true },
    where: { teamId: approval.teamId },
  });
  return settings?.botUserId === approval.userId;
};

/** Refuse an approval the caller may not decide (404 unseen, 403 not theirs). */
export const assertCanDecideApproval = async (
  approval: ToolApprovalRequest,
  caller: Caller,
): Promise<void> => {
  await assertCanViewApproval(approval, caller);
  if (await isApprovalDecidableBy(approval, caller.userId)) return;
  return throwHttpError(
    403,
    forbidden(
      "This action runs with another person's access: only they can decide it",
    ),
  );
};
