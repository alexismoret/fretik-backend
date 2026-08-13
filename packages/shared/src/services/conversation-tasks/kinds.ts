import { inArray } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskTerminalStatus,
} from "../../db/schema";
import { bulkOperations, workflowRuns } from "../../db/schema";
import type { WorkflowRunStatus } from "../../schemas/workflows";

/**
 * Per-kind reconciliation for the wait registry's sweep.
 *
 * The registry has always been kind-generic in its SCHEMA — a `text` column and
 * a TS union, so a new kind is one line — but the sweep that repairs it was
 * hardcoded to workflow runs. That asymmetry is exactly how a second kind gets
 * a silent hole: its rows would stay `pending` forever after a lost completion
 * signal, and with them every later task of the same conversation, because the
 * fan-in never clears. So the sweep resolves through this table instead.
 *
 * A reconciler answers ONE question in batch: for these refs, which underlying
 * work is already terminal? A ref with no entry in the returned map is still
 * running (or too young to judge) and is left alone.
 */
export interface ConversationTaskReconciler {
  resolve(refs: string[]): Promise<Map<string, ConversationTaskTerminalStatus>>;
}

/** A run's outcome, once it has one — null while it is still going. */
const taskStatusOfRun = (
  status: WorkflowRunStatus,
): ConversationTaskTerminalStatus | null => {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
};

const workflowRunReconciler: ConversationTaskReconciler = {
  resolve: async (refs) => {
    const out = new Map<string, ConversationTaskTerminalStatus>();
    if (refs.length === 0) return out;
    const rows = await db
      .select({ id: workflowRuns.id, status: workflowRuns.status })
      .from(workflowRuns)
      .where(inArray(workflowRuns.id, refs));

    const byId = new Map(rows.map((r) => [r.id, r.status]));
    for (const ref of refs) {
      const status = byId.get(ref);
      // No run row at all (the workflow was deleted): nothing will ever report
      // on it, so settle the wait rather than block the conversation forever.
      if (status === undefined) {
        out.set(ref, "failed");
        continue;
      }
      const terminal = taskStatusOfRun(status);
      if (terminal !== null) out.set(ref, terminal);
    }
    return out;
  },
};

const bulkOperationReconciler: ConversationTaskReconciler = {
  resolve: async (refs) => {
    const out = new Map<string, ConversationTaskTerminalStatus>();
    if (refs.length === 0) return out;
    const rows = await db
      .select({ id: bulkOperations.id, status: bulkOperations.status })
      .from(bulkOperations)
      .where(inArray(bulkOperations.id, refs));

    const byId = new Map(rows.map((r) => [r.id, r.status]));
    for (const ref of refs) {
      const status = byId.get(ref);
      if (status === undefined) {
        out.set(ref, "failed");
        continue;
      }
      if (status === "done") out.set(ref, "succeeded");
      else if (status === "failed") out.set(ref, "failed");
      else if (status === "cancelled") out.set(ref, "canceled");
    }
    return out;
  },
};

export const CONVERSATION_TASK_RECONCILERS: Record<
  ConversationTaskKind,
  ConversationTaskReconciler
> = {
  workflow_run: workflowRunReconciler,
  bulk_operation: bulkOperationReconciler,
};
