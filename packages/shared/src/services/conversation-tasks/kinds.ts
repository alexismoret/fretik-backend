import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskTerminalStatus,
} from "../../db/schema";
import {
  bulkOperations,
  conversationBackgroundTasks,
  workflowRuns,
} from "../../db/schema";
import { owedSubAgentJobs } from "../../lib/queue/sub-agents";
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
 * The bound on a sub-agent the queue still says it owes. Far above any real
 * backlog (a worker picks a job up in milliseconds) and above a run's own
 * 20-minute deadline; what it catches is a queue with no worker left to drain
 * it, which would otherwise hold the conversation's resume forever.
 */
const SUB_AGENT_OWED_MAX_MS = 60 * 60 * 1000;

/**
 * A sub-agent has no work row: its job runs on an AI replica's queue worker,
 * which settles its own task. It stays pending for good only if that never
 * happens. So a row the sweep asks about settles as failed when nothing still
 * answers for it: no heartbeat (no worker is running it now) AND no job the
 * queue owes (none will). A job waiting for a worker has no heartbeat by
 * construction, and one whose worker died waits for the queue to hand it to
 * another replica — neither reads as dead until it has been owed absurdly
 * long. The continuation then tells the agent it stopped without a report,
 * which is the truth.
 */
const subAgentReconciler: ConversationTaskReconciler = {
  resolve: async (refs) => {
    const out = new Map<string, ConversationTaskTerminalStatus>();
    if (refs.length === 0) return out;
    const [rows, alive, owed] = await Promise.all([
      db
        .select({
          ref: conversationBackgroundTasks.ref,
          createdAt: conversationBackgroundTasks.createdAt,
        })
        .from(conversationBackgroundTasks)
        .where(
          and(
            eq(conversationBackgroundTasks.kind, "sub_agent"),
            inArray(conversationBackgroundTasks.ref, refs),
          ),
        ),
      liveSubAgents(refs),
      owedSubAgentJobs(refs),
    ]);
    for (const ref of deadSubAgents(rows, { alive, owed }, Date.now())) {
      out.set(ref, "failed");
    }
    return out;
  },
};

/**
 * The verdict itself, apart from the reads: which of these pending sub-agents
 * will never report. Exported for its test.
 */
export const deadSubAgents = (
  rows: readonly { ref: string; createdAt: Date }[],
  seen: { alive: ReadonlySet<string>; owed: ReadonlySet<string> },
  now: number,
): string[] =>
  rows
    .filter((row) => {
      if (seen.alive.has(row.ref)) return false;
      if (!seen.owed.has(row.ref)) return true;
      return now - row.createdAt.getTime() > SUB_AGENT_OWED_MAX_MS;
    })
    .map((row) => row.ref);

export const CONVERSATION_TASK_RECONCILERS: Record<
  ConversationTaskKind,
  ConversationTaskReconciler
> = {
  workflow_run: workflowRunReconciler,
  bulk_operation: bulkOperationReconciler,
  sub_agent: subAgentReconciler,
};
