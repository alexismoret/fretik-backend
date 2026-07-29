import { and, count, eq, isNotNull, ne, or } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";

/**
 * Test runs of one workflow already launched from one chat conversation.
 *
 * The builder loop (run_test → resume → update → run_test) has no other
 * bound: the in-flight guard is cron-only, `evaluateCircuitBreaker` skips
 * `isTest`, and the auto-resume lock is keyed per RUN. Counting per
 * (workflow, source conversation) is what makes an iteration budget possible
 * without touching genuine re-tests in a different conversation.
 *
 * Runs that failed at CREATION (INPUT_MISSING / TRIGGER_FAILED — `startedAt`
 * never stamped) don't count: they consumed no model work and taught the
 * builder nothing, so burning an iteration slot on each would let two
 * forgotten-attachment mistakes eat the budget a real test needs.
 */
export const countTestRuns = async (params: {
  workflowId: string;
  sourceConversationId: string;
}): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, params.workflowId),
        eq(workflowRuns.sourceConversationId, params.sourceConversationId),
        eq(workflowRuns.isTest, true),
        or(
          ne(workflowRuns.status, "failed"),
          isNotNull(workflowRuns.startedAt),
        ),
      ),
    );
  return row?.value ?? 0;
};
