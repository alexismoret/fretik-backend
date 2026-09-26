import { inArray } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskTerminalStatus,
} from "../../db/schema";
import { bulkOperations, workflowRuns } from "../../db/schema";
import { liveSubAgents } from "../../lib/sub-agent-heartbeat";
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

/**
 * A run's outcome, once it has one — null while it is still going.
 *
 * Exported because `on-run-terminal` asks the same question one layer up
 * ("is this run over, and how did it end?") and two copies of this switch
 * would drift the moment a status is added — which is exactly what happened
 * to the three inline `!== "succeeded" && !== "failed" && ...` chains it
 * replaced.
 */
export const terminalTaskStatusOfRun = (
  status: WorkflowRunStatus,
): ConversationTaskTerminalStatus | null => {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    // A run that found nothing to do, and one the trigger gate never let
    // start, are both OVER. The conversation vocabulary has no third word for
    // "finished without working", and inventing one would mean teaching every
    // reconciler a distinction none of them acts on — so they settle as
    // succeeded. Leaving them to fall through to `null` is what would hurt:
    // the wait would never settle and a chat that launched a test run would
    // hang on it forever.
    case "not_applicable":
    case "filtered":
      return "succeeded";
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
      const terminal = terminalTaskStatusOfRun(status);
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

/**
 * A background sub-agent has no work row: it lives in the AI process that
 * launched it, and settles its own task when it ends. The only way it stays
 * pending is that process dying mid-run — so a row the sweep considers (older
 * than `RECONCILE_AFTER_MS`) whose heartbeat has lapsed is a run that will
 * never report, and settles as failed. The continuation then tells the agent
 * it stopped without a report, which is the truth.
 */
const subAgentReconciler: ConversationTaskReconciler = {
  resolve: async (refs) => {
    const out = new Map<string, ConversationTaskTerminalStatus>();
    const alive = await liveSubAgents(refs);
    for (const ref of refs) {
      if (!alive.has(ref)) out.set(ref, "failed");
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
  sub_agent: subAgentReconciler,
};
