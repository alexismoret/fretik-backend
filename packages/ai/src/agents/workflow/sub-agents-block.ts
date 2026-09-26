import { consumeConversationTasks } from "@fretik/shared/services/conversation-tasks/consume";
import { listOpenSubAgentTasks } from "@fretik/shared/services/conversation-tasks/list";
import { buildSubAgentContinuation } from "../../services/conversation-tasks/sub-agent-continuation";

/**
 * Where the run's sub-agents stand, for the next turn's steering message.
 *
 * A workflow turn that ends while its sub-agents still work is followed at
 * once by the next one — there is no resume to wait for, and nothing else
 * would tell the executor about work it started on the turn before. So the
 * steering message says it: which ones still run, and the reports of those
 * that finished since, handed over here and consumed, like a chat's resume.
 *
 * Called only when the steering message is about to be WRITTEN — a replayed
 * turn finds its message already saved, reports included.
 */
export const buildRunSubAgentsBlock = async (
  conversationId: string,
): Promise<string | undefined> => {
  const open = await listOpenSubAgentTasks(conversationId);
  if (open.length === 0) return undefined;
  const running = open.filter((task) => task.status === "pending");
  const collected = await consumeConversationTasks({
    conversationId,
    kind: "sub_agent",
    refs: open
      .filter((task) => task.status !== "pending")
      .map((task) => task.ref),
  });
  if (running.length === 0 && collected.length === 0) return undefined;
  const lines = [
    ...collected.map((task) => buildSubAgentContinuation(task).line),
    ...running.map(
      (task) =>
        `Sub-agent "${task.title}" (${task.ref}) is still running — ${(task.metadata?.subAgent?.step ?? 0).toString()} tool calls so far.`,
    ),
  ];
  if (collected.length > 0) {
    lines.push(
      "Use each report like a result of your own: `completed` → build on it; `partial` → use what it found and finish the rest; `failed` → do that part yourself.",
    );
  }
  if (running.length > 0) {
    lines.push(
      "Collect the running ones with `manageAgents` `wait` once you need them.",
    );
  }
  return lines.join("\n");
};
