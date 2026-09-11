import db from "../../db";
import type { WorkflowAutonomy } from "../../schemas/workflows";

/**
 * What the run a conversation belongs to says about how its tools may behave.
 * `null` from the lookup = a regular chat conversation, not a run.
 */
export interface WorkflowRunContext {
  runId: string;
  workflowId: string;
  /**
   * The workflow's owner. `null` = team-shared, which means the run acts as
   * the team bot and can only ever reach team-shared connections.
   */
  ownerUserId: string | null;
  autonomy: WorkflowAutonomy;
  /** The external apps the workflow declares, as currently stored. */
  externalAppConnectionIds: string[];
}

/**
 * Resolve the run governing a conversation — one indexed lookup, joined to the
 * workflow, shared by everything the sandbox seam needs to know about a run.
 *
 * `autonomy` is the reason this exists: it is the seam that makes a run's write
 * mode enforced SERVER-side (`read_only` rejects plans, `autonomous` executes
 * them without pausing) rather than a suggestion in a prompt. `ownerUserId` and
 * `externalAppConnectionIds` come along because they are columns of the same
 * row, and the external-app dispatch needs all three on the same call — asking
 * twice would double the queries for nothing.
 */
export const getWorkflowRunContext = async (
  conversationId: string,
): Promise<WorkflowRunContext | null> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { conversationId },
    columns: { id: true, workflowId: true },
    with: {
      workflow: {
        columns: {
          userId: true,
          autonomy: true,
          externalAppConnectionIds: true,
        },
      },
    },
  });
  // A run whose workflow is gone reads as "no run", exactly as it did when
  // this was two queries — the gates it feeds must fail open to plain chat,
  // never to an unguarded run.
  if (!run?.workflow) return null;
  return {
    runId: run.id,
    workflowId: run.workflowId,
    ownerUserId: run.workflow.userId,
    autonomy: run.workflow.autonomy,
    externalAppConnectionIds: run.workflow.externalAppConnectionIds,
  };
};
