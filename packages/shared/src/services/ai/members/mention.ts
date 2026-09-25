import { and, eq, inArray } from "drizzle-orm";
import type { ResolvedResource } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { aiConversationMembers } from "../../../db/schema";
import { resolvePrincipals } from "../../access/sharing/principals";
import { writeShares } from "../../access/sharing/share";
import type { TeamMember } from "../../team/members";
import { takingPartCandidates } from "./candidates";

/**
 * Apply the @mentions carried by a user message. Each mentioned teammate is:
 *  - seated in the conversation if they do not take part yet, like anyone a
 *    participant brings in (`addConversationMembers`), and
 *  - flagged with `mentionedAt = now` so their conversation list shows an
 *    "action required" badge until they read.
 *
 * The author is never mentioned to themselves, and only the real people who
 * may take part are honoured: the conversation's project participants when
 * it is in one, else its team's people. Returns the mentioned members so the
 * caller (the AI handler) can send the notification emails — keeping email
 * I/O out of the data layer.
 */
export const applyMentions = async (data: {
  principal: UserPrincipal;
  resource: ResolvedResource;
  mentionedUserIds: string[];
}): Promise<TeamMember[]> => {
  const { principal, resource, mentionedUserIds } = data;
  if (mentionedUserIds.length === 0) return [];
  const conversationId = resource.node.id;

  const byId = new Map(
    (await takingPartCandidates(resource.node, mentionedUserIds)).map((m) => [
      m.userId,
      m,
    ]),
  );
  const mentioned = [...new Set(mentionedUserIds)]
    .filter((id) => id !== principal.userId && byId.has(id))
    .map((id) => byId.get(id)!);

  if (mentioned.length === 0) return [];
  const ids = mentioned.map((m) => m.userId);

  // A seat gives `use` or `full`; a person at `view` only reads.
  const seated = new Set(
    resource.node.grants.flatMap((grant) =>
      grant.principalType === "user" && grant.level !== "view"
        ? [grant.principalId]
        : [],
    ),
  );
  const newcomers = ids.filter((id) => !seated.has(id));
  if (newcomers.length > 0) {
    const grantees = await resolvePrincipals(
      principal.organizationId,
      newcomers.map((id) => ({ type: "user" as const, id })),
    );
    await writeShares({
      principal,
      node: resource.node,
      type: "conversation",
      grantees: [...grantees.values()],
      level: "use",
    });
  }

  await db
    .update(aiConversationMembers)
    .set({ mentionedAt: new Date() })
    .where(
      and(
        eq(aiConversationMembers.conversationId, conversationId),
        inArray(aiConversationMembers.userId, ids),
      ),
    );

  return mentioned;
};
