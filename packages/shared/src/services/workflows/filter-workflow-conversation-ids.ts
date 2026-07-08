import db from "../../db";

/**
 * Of the given conversation ids, the subset that belong to WORKFLOW runs
 * (`agent_type = 'workflow'`). The event-trigger anti-loop guard: every write
 * a run performs — the agent directly, the Python SDK (`fretik_apps`), or a
 * dispatched sub-agent — is journaled with the run's own conversation id.
 * `actorType`/`agentKey` catch only the direct writes; matching on the
 * conversation catches all three, so a run can never re-trigger itself.
 */
export const filterWorkflowConversationIds = async (params: {
  conversationIds: string[];
}): Promise<Set<string>> => {
  if (params.conversationIds.length === 0) return new Set();
  const rows = await db.query.aiConversations.findMany({
    where: { id: { in: params.conversationIds }, agentType: "workflow" },
    columns: { id: true },
  });
  return new Set(rows.map((r) => r.id));
};
