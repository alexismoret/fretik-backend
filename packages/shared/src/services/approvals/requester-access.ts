import { userHasCapability } from "../../authz/gates";
import type { ToolApprovalRequest } from "../../db/schema";

/**
 * Whether the person an approval writes for may still change the team's
 * content (`team.content.create`: its leads and members, not its viewers).
 *
 * An approval can wait for hours. The tool asked before it opened the card;
 * whoever approves decides whether the write is WANTED, not whether the
 * person it acts for may still make it — they may have been made a viewer, or
 * left, meanwhile. So a grant that writes records asks again, and writes
 * nothing for someone who may no longer.
 */
export const requesterMayContribute = (
  approval: Pick<ToolApprovalRequest, "userId" | "organizationId" | "teamId">,
): Promise<boolean> =>
  userHasCapability({
    userId: approval.userId,
    organizationId: approval.organizationId,
    capability: "team.content.create",
    teamId: approval.teamId,
  });

/** What a refused grant says, on each record it did not write. */
export const REQUESTER_CANNOT_CONTRIBUTE =
  "The person this was for can no longer change this team's content.";
