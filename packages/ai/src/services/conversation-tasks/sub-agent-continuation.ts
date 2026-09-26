import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import type { ConversationTaskContinuation } from "./continuation-registry";

/**
 * How to use what came back. Once per batch, whatever the mix of outcomes: it
 * is the same rule as a foreground `dispatchAgent` result, restated because the
 * report now arrives in a message instead of a tool result.
 */
const SUB_AGENT_DOCTRINE =
  "These are reports from sub-agents you started in the background — use each exactly like a `dispatchAgent` result: `completed` → build on it; `partial` → use what it found, then finish that part yourself or dispatch a narrower task; `failed` → do that part yourself. Files they wrote reach the user only through `presentFiles`. Then finish the work you started them for and answer — the user has not spoken since.";

const minutes = (ms: number): string =>
  `${Math.max(1, Math.round(ms / 60_000)).toString()} min`;

/**
 * One finished background sub-agent, as the resumed agent reads it: what it
 * was, how it ended, and its whole report — the report IS the outcome, and
 * nothing else holds it.
 */
export const buildSubAgentContinuation = (
  task: ConversationBackgroundTask,
): { line: string; actingUserId: string | null } => {
  const state = task.metadata?.subAgent;
  const actingUserId = state?.launchedByUserId ?? null;
  const name = `Sub-agent "${task.title}" (${task.ref})`;
  const result = state?.result;

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
  const files =
    result.files && result.files.length > 0
      ? `\nFiles: ${result.files.join(", ")}`
      : "";
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
