import type {
  ConversationBackgroundTask,
  ConversationTaskKind,
} from "@fretik/shared/db/schema";
import { buildBulkOperationContinuation } from "./bulk-operation-continuation";
import {
  buildWorkflowRunContinuation,
  workflowRunDoctrine,
} from "./workflow-run-continuation";

/**
 * One finished task, as the agent will read it.
 *
 * `tags` is how a kind carries its own vocabulary through a generic pipeline:
 * the workflow builder tags a line `test` or `real`, and its doctrine reads
 * those back. A kind with nothing to distinguish leaves it empty.
 */
export interface TaskLine {
  line: string;
  /** Whoever launched the work — the acting identity for the resumed turn. */
  actingUserId: string | null;
  tags: string[];
}

/**
 * Per-kind continuation for the resume message.
 *
 * The registry that was missing: the resume builder used to call the workflow
 * builder directly, so a second kind of background work would have woken the
 * conversation with an empty message and consumed its own outcome — the worst
 * possible failure, since the row is marked handled either way.
 */
export interface ConversationTaskContinuation {
  /** One line stating what this task did, or null if its work row vanished. */
  buildLine(task: ConversationBackgroundTask): Promise<TaskLine | null>;
  /**
   * How to deal with this KIND of outcome, emitted once for the batch — it is
   * a way of working, not a per-task instruction. Gets the lines that were
   * actually built so it can adapt to what came back.
   */
  doctrine(lines: TaskLine[]): string[];
}

const workflowRunContinuation: ConversationTaskContinuation = {
  buildLine: async (task) => {
    const built = await buildWorkflowRunContinuation(task);
    if (!built) return null;
    return {
      line: built.line,
      actingUserId: built.triggeredByUserId,
      tags: [built.isTest ? "test" : "real"],
    };
  },
  doctrine: (lines) =>
    workflowRunDoctrine({
      hasTest: lines.some((l) => l.tags.includes("test")),
      hasReal: lines.some((l) => l.tags.includes("real")),
    }),
};

export const CONVERSATION_TASK_CONTINUATIONS: Record<
  ConversationTaskKind,
  ConversationTaskContinuation
> = {
  workflow_run: workflowRunContinuation,
  bulk_operation: buildBulkOperationContinuation,
};
