import { propagateAttributes } from "@langfuse/tracing";
import { withSoftTimeout } from "../../lib/stream-errors";
import { runUnifiedRecall } from "../../services/recall/recall";

/**
 * What a workflow run retrieves on its FIRST turn.
 *
 * A run has nobody typing, so there is no user message to match retrieval
 * against. What stands in for it is the workflow's own name and goal, with the
 * trigger payload as the recent tail — and that substitution IS the workflow
 * memory path. It used to live as four arguments inside a `Promise.all` in the
 * handler, where nothing could state it and no eval could reach it.
 *
 * Turn 1 only, and only with an acting user. Recall scopes private rows to the
 * caller (`user_id IS NULL OR user_id = :caller`), so a run with no acting
 * user gets NO block rather than a team-wide one — the same rule that makes
 * `mr-private-leak` run as another person instead of as nobody.
 */
const RECALL_TIMEOUT_MS = 18_000;
const TRIGGER_TAIL_CHARS = 2000;

export const recallForWorkflowTurnOne = async (input: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  actingUserId: string | undefined;
  workflowName: string;
  playbookGoal: string;
  triggerPayload: unknown;
  /**
   * EVAL ONLY. A run's query is its workflow's name and goal, which never
   * change — so N repeats of one case are N identical keys into the 15 s
   * in-process cache, and the suite measures the cache. Measured 2026-09-11:
   * three repeats produced ONE recall call and shared its result, including
   * when that result was an embedding timeout.
   */
  bypassCache?: boolean;
}): Promise<string | undefined> => {
  if (input.actingUserId === undefined) return undefined;
  const result = await propagateAttributes(
    {
      traceName: "active-memory-recall",
      sessionId: input.conversationId,
      userId: input.actingUserId,
      tags: [`team:${input.teamId}`],
    },
    () =>
      withSoftTimeout(
        runUnifiedRecall({
          userMessage: `${input.workflowName}\n${input.playbookGoal}`,
          attachedFiles: [],
          recentTail: JSON.stringify(input.triggerPayload).slice(
            0,
            TRIGGER_TAIL_CHARS,
          ),
          teamId: input.teamId,
          organizationId: input.organizationId,
          userId: input.actingUserId,
          conversationId: input.conversationId,
          agentType: "workflow",
          bypassCache: input.bypassCache,
        }),
        RECALL_TIMEOUT_MS,
        null,
        "active-memory",
      ),
  );
  return result?.block ?? undefined;
};
