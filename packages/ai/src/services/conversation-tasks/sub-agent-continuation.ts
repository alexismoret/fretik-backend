import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import type { ConversationTaskContinuation } from "./continuation-registry";

/**
 * How to use what came back. Once per batch, whatever the mix of outcomes: the
 * rule for a report, restated because it arrives in a message instead of a
 * tool result.
 */
const SUB_AGENT_DOCTRINE =
  "These are reports from sub-agents you started: `completed` → build on it; `partial` → use what it found, then finish that part yourself or dispatch a narrower task; `failed` → do that part yourself. A sub-agent the user stopped is not to be restarted unless they ask. Files they wrote reach the user only through `presentFiles`. Then finish the work you started them for and answer — the user has not spoken since.";

const minutes = (ms: number): string =>
  `${Math.max(1, Math.round(ms / 60_000)).toString()} min`;

/**
 * One finished sub-agent, as its reader sees it: what it was, how it ended,
 * and its whole report — the report IS the outcome, and nothing else holds
 * it. Read by the resumed chat turn and by a workflow run's next turn.
 */
export const buildSubAgentContinuation = (
  task: ConversationBackgroundTask,
): { line: string; actingUserId: string | null } => {
  const state = task.metadata?.subAgent;
  const actingUserId = state?.launchedByUserId ?? null;
  const name = `Sub-agent "${task.title}" (${task.ref})`;
  const result = state?.result;
  const files =
    result?.files && result.files.length > 0
      ? `\nFiles: ${result.files.join(", ")}`
      : "";

  // Stopped by the user from its row. A stop by the assistant or by the Stop
  // of the answer that launched it never reaches here: it settles consumed.
  if (task.status === "canceled") {
    const done =
      result === undefined
        ? "before it started"
        : `after ${result.toolCalls.toString()} tool calls`;
    return {
      line: `${name} was stopped by the user ${done}; it wrote no report.${files}`,
      actingUserId,
    };
  }

  // Settled with no report: its process died mid-run and the sweep closed the
  // wait (`conversation-tasks/kinds.ts`).
  if (result === undefined) {
    return {
      line: `${name} failed: it stopped before finishing and wrote no report.`,
      actingUserId,
    };
  }

  const how =
    result.status === "completed"
      ? "completed"
      : `${result.status}${result.reason ? ` (${result.reason})` : ""}`;
  return {
    line: `${name} ${how} — ${result.toolCalls.toString()} tool calls, ${minutes(result.durationMs)}.\n<report>\n${result.summary}\n</report>${files}`,
    actingUserId,
  };
};

export const subAgentContinuation: ConversationTaskContinuation = {
  buildLine: async (task) => {
    const built = buildSubAgentContinuation(task);
    return { ...built, tags: [] };
  },
  doctrine: () => [SUB_AGENT_DOCTRINE],
};
