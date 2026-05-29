import { eq } from "drizzle-orm";
import db from "../../../db";
import { aiConversations } from "../../../db/schema";

/**
 * Return the set of provider keys with at least one active connection
 * on the team that owns the given conversation.
 *
 * Used by `conversation-storage.bootstrapSandbox` to decide which
 * `sandbox-assets/skills/<providerKey>/` bundles to push into the
 * sandbox — pushing the Gmail SKILL.md to a team that only has
 * Outlook is bandwidth + token waste.
 *
 * Returns `[]` when:
 *  - the conversation is unknown (e.g. bootstrap fired on a
 *    just-created row whose teamId isn't visible yet),
 *  - the owning team has no active external-app connections.
 *
 * Deduplicated and sorted (deterministic) so two parallel bootstraps
 * land the same set in the same order. We don't filter on `userId`
 * here because the bootstrap is shared across every member of the
 * team using this sandbox — anyone could be the next user message.
 */
export const listActiveProviderKeysForConversation = async (
  conversationId: string,
): Promise<string[]> => {
  const convRows = await db
    .select({ teamId: aiConversations.teamId })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId))
    .limit(1);

  const teamId = convRows[0]?.teamId;
  if (!teamId) return [];

  const rows = await db.query.externalAppConnections.findMany({
    columns: { providerKey: true },
    where: { teamId, status: "active" },
  });

  const set = new Set<string>();
  for (const row of rows) set.add(row.providerKey);
  return Array.from(set).sort();
};
