import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import { consumeConversationTasks } from "@fretik/shared/services/conversation-tasks/consume";
import { listOpenSubAgentTasks } from "@fretik/shared/services/conversation-tasks/list";
import { z } from "zod";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";

/**
 * `checkAgents` — where the background sub-agents of this conversation stand,
 * and the reports of those that finished.
 *
 * The one thing a background dispatch takes away is knowing: the parent keeps
 * working, and nothing tells it mid-turn whether its sub-agents are done. The
 * resume answers at the END of the turn; this answers during it, so a parent
 * whose own work finished after theirs collects the reports without a turn
 * break — and one that finished first learns there is nothing to do but end
 * its turn.
 *
 * A report is handed over ONCE: collecting it consumes its task row, exactly
 * as a resume's claim does, so the conversation is not woken later to deliver
 * it again (`services/conversation-tasks/consume.ts`).
 *
 * Hidden unless the conversation has such sub-agents (the chatbot's
 * `prepareStep`): useless everywhere else, and a tool on the list is a tool a
 * model will eventually call for nothing.
 */

export const CHECK_AGENTS_TOOL = "checkAgents";

interface RunningAgent {
  agentId: string;
  description: string;
  /** Tool calls issued so far. */
  step: number;
  /** The caption of its latest call, when it wrote one. */
  doing?: string;
  runningForMinutes: number;
}

interface FinishedAgent {
  agentId: string;
  description: string;
  status: "completed" | "partial" | "failed";
  summary: string;
  files?: string[];
  reason?: string;
  toolCalls?: number;
}

export interface CheckAgentsOutput {
  running: RunningAgent[];
  finished: FinishedAgent[];
  next?: string;
}

const runningOf = (
  task: ConversationBackgroundTask,
  now: number,
): RunningAgent => {
  const state = task.metadata?.subAgent;
  const doing = state?.activity?.at(-1)?.caption;
  return {
    agentId: task.ref,
    description: task.title,
    step: state?.step ?? 0,
    ...(doing !== undefined ? { doing } : {}),
    runningForMinutes: Math.floor(
      (now - (state?.startedAt ?? task.createdAt.getTime())) / 60_000,
    ),
  };
};

const finishedOf = (task: ConversationBackgroundTask): FinishedAgent => {
  const result = task.metadata?.subAgent?.result;
  if (result === undefined) {
    return {
      agentId: task.ref,
      description: task.title,
      status: "failed",
      summary: "It stopped before finishing and wrote no report.",
    };
  }
  return {
    agentId: task.ref,
    description: task.title,
    status: result.status,
    summary: result.summary,
    ...(result.files && result.files.length > 0 ? { files: result.files } : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    toolCalls: result.toolCalls,
  };
};

export const createCheckAgentsTool = () =>
  buildChatbotTool({
    category: "core",
    searchHint:
      "background sub-agents status progress reports finished running wait",
    // It hands over reports — the parent's only copy of that work — so it is
    // never compacted away, like `dispatchAgent`'s own result.
    isReadOnly: false,
    description: [
      "Where your background sub-agents stand: those still running (with the step they are on), and the reports of those that finished. Each report is handed over once — here, or when you are resumed.",
      "Call it when your own work is done and you need their results. If some are still running, end your turn: you are resumed with their reports when the last one finishes. Never call it again to wait.",
    ].join("\n"),
    inputSchema: z.object({}),
    execute: async (
      _input,
      options,
    ): Promise<CheckAgentsOutput | ToolErrorOutput> => {
      const ctx = getRuntimeContext(options);
      if (ctx.conversationId === undefined) {
        return toolError(
          TOOL_ERROR_CODES.NO_CONVERSATION,
          "No conversation, so no background sub-agents.",
        );
      }
      const open = await listOpenSubAgentTasks(ctx.conversationId);
      const running = open.filter((task) => task.status === "pending");
      // Only what this call actually claimed: a resume racing it keeps the
      // rows it got, and those reports reach the agent through it instead.
      const collected = await consumeConversationTasks({
        conversationId: ctx.conversationId,
        kind: "sub_agent",
        refs: open
          .filter((task) => task.status !== "pending")
          .map((task) => task.ref),
      });
      const now = Date.now();
      return {
        running: running.map((task) => runningOf(task, now)),
        finished: collected.map(finishedOf),
        ...(running.length > 0
          ? {
              next: "Work that does not need them? Do it. Otherwise end your turn now — you are resumed with the remaining reports.",
            }
          : open.length === 0
            ? { next: "No background sub-agent is open." }
            : {}),
      };
    },
  });
