import { resolveAccess } from "../../authz/access";
import { atLeast } from "../../authz/levels";
import type { UserPrincipal } from "../../authz/principal";
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
 *     bodies, record values). Seeing it takes the right to read that
 *     conversation (`assertConversationAccess`).
 *
 *   - A granted approval EXECUTES AS its requester (`approval.userId`): the
 *     plan resolves that person's connections, personal ones included. So when
 *     the requester is a person, deciding is theirs alone — a teammate granting
 *     it would be acting through someone else's mailbox. When the requester is
 *     the team's own identity (the agent a team workflow runs as), the action
 *     runs with team resources only, and whoever may RUN that workflow (`use`)
 *     may decide it — monitoring a team workflow requires it, and a reader who
 *     may only look at the workflow may not act through it.
 */

/** Refuse (404) an approval the caller may not see. */
export const assertCanViewApproval = async (
  approval: ToolApprovalRequest,
  caller: UserPrincipal,
): Promise<void> => {
  await assertConversationAccess({
    conversationId: approval.conversationId,
    principal: caller,
    level: "view",
  });
};

/**
 * Whether the caller may decide an approval they can see: they requested it,
 * or it runs as the team's agent and they may run the workflow that raised it.
 * Does not check visibility — pair it with `assertCanViewApproval`, or use
 * `assertCanDecideApproval`.
 */
export const isApprovalDecidableBy = async (
  approval: ToolApprovalRequest,
  caller: UserPrincipal,
): Promise<boolean> => {
  if (approval.userId === caller.userId) return true;
  const settings = await db.query.teamSettings.findFirst({
    columns: { botUserId: true },
    where: { teamId: approval.teamId },
  });
  if (settings?.botUserId !== approval.userId) return false;

  const run = await db.query.workflowRuns.findFirst({
    columns: { workflowId: true },
    where: { conversationId: approval.conversationId },
  });
  if (!run) return false;
  const workflow = await resolveAccess(caller, "workflow", run.workflowId);
  return workflow !== null && atLeast(workflow.level, "use");
};

/** Refuse an approval the caller may not decide (404 unseen, 403 not theirs). */
export const assertCanDecideApproval = async (
  approval: ToolApprovalRequest,
  caller: UserPrincipal,
): Promise<void> => {
  await assertCanViewApproval(approval, caller);
  if (await isApprovalDecidableBy(approval, caller)) return;
  return throwHttpError(
    403,
    forbidden(
      "This action runs with another person's access: only they can decide it",
    ),
  );
};
