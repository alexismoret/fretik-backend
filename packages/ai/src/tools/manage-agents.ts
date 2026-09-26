import type {
  ConversationBackgroundTask,
  SubAgentStopper,
} from "@fretik/shared/db/schema";
import { consumeConversationTasks } from "@fretik/shared/services/conversation-tasks/consume";
import {
  listOpenSubAgentTasks,
  listSubAgentTasks,
} from "@fretik/shared/services/conversation-tasks/list";
import { requestSubAgentStop } from "@fretik/shared/services/conversation-tasks/request-sub-agent-stop";
import type { ToolExecutionOptions } from "ai";
import { z } from "zod";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../agents/shared/runtime-context";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";
import { subAgentDeadlineMs } from "../services/sub-agents/report";

/**
 * `manageAgents` — the parent's hold on the sub-agents it started: where they
 * stand, waiting for them, stopping them.
 *
 * `dispatchAgent` answers before the work is done, so the parent needs a way
 * to know, to wait and to change its mind — the three things Claude Code
 * (`/tasks`, `TaskStop`), Codex (`list_agents`, `wait_agent`,
 * `interrupt_agent`) and Hermes give theirs. One tool with an action rather
 * than three, because a tool on the list is a tool a model will eventually
 * call for nothing, and this one is only on it once the conversation has
 * sub-agents (the agents' `prepareStep`).
 *
 * A report is handed over ONCE: collecting it consumes its task row, exactly
 * as a resume's claim does, so the conversation is not woken later to deliver
 * it again (`@fretik/shared/services/conversation-tasks/consume`).
 *
 * WAITING in a chat is bounded on purpose. The default way to wait there is to
 * end the turn — the conversation resumes itself with every report, and the
 * user is not held in front of a spinning answer. `wait` is for the last
 * stretch, when the reports are what the rest of the answer is made of. A
 * workflow turn has nobody to hand the floor to, so there it waits for as long
 * as a sub-agent may run.
 */

export const MANAGE_AGENTS_TOOL = "manageAgents";

/** How often a wait re-reads the task rows. */
const POLL_MS = 2_000;
/** The longest a chat turn is held open by one `wait`. */
const CHAT_WAIT_MAX_MS = 5 * 60 * 1000;
/** How long a `stop` waits for its runs to settle and hand back what they had. */
const STOP_SETTLE_MS = 10_000;

export const manageAgentsInputSchema = z.object({
  action: z
    .enum(["status", "wait", "stop"])
    .describe(
      "`status`: where they stand, and the reports of those that finished. `wait`: block until they have all finished, then hand back their reports. `stop`: stop them now, keeping what they had done.",
    ),
  agentIds: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      "The `agentId`s `dispatchAgent` returned. Omitted: every sub-agent of this conversation.",
    ),
});

type ManageAgentsInput = z.infer<typeof manageAgentsInputSchema>;

export interface RunningAgent {
  agentId: string;
  description: string;
  /** Tool calls issued so far. */
  step: number;
  /** The caption of its latest call, when it wrote one. */
  doing?: string;
  /** Still waiting for a worker: it has not started. */
  queued?: true;
  /** Asked to stop, and not stopped yet. */
  stopping?: true;
  runningForMinutes: number;
}

export interface FinishedAgent {
  agentId: string;
  description: string;
  status: "completed" | "partial" | "failed";
  summary: string;
  files?: string[];
  reason?: string;
  toolCalls?: number;
  /** Who stopped it, when it was stopped. */
  stoppedBy?: SubAgentStopper;
}

export interface ManageAgentsOutput {
  action: ManageAgentsInput["action"];
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
    ...(state?.startedAt === undefined ? { queued: true as const } : {}),
    ...(state?.stopRequested !== undefined ? { stopping: true as const } : {}),
    runningForMinutes: Math.floor(
      (now - (state?.startedAt ?? task.createdAt.getTime())) / 60_000,
    ),
  };
};

export const finishedOf = (task: ConversationBackgroundTask): FinishedAgent => {
  const state = task.metadata?.subAgent;
  const stoppedBy = state?.stopRequested;
  const result = state?.result;
  if (result === undefined) {
    return {
      agentId: task.ref,
      description: task.title,
      status: "failed",
      summary: "It stopped before finishing and wrote no report.",
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
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
    ...(task.status === "canceled" && stoppedBy !== undefined
      ? { stoppedBy }
      : {}),
  };
};

/** Resolve after `ms`, or as soon as `signal` aborts. */
const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * The sub-agents a call is about. Named ones are read whatever their state —
 * asking about one by id must answer, even if its report was handed over
 * before (then it is handed over again: the parent may have lost it to a
 * compaction). Unnamed, only the open ones: running, or with a report nobody
 * has read.
 */
const targetsOf = async (
  conversationId: string,
  agentIds: readonly string[] | undefined,
): Promise<ConversationBackgroundTask[]> =>
  agentIds === undefined
    ? listOpenSubAgentTasks(conversationId)
    : listSubAgentTasks(conversationId, agentIds);

/**
 * Split targets into running and finished, handing each finished report over:
 * consumed if nobody had read it, re-read if someone had.
 */
const collect = async (
  conversationId: string,
  targets: readonly ConversationBackgroundTask[],
): Promise<{ running: RunningAgent[]; finished: FinishedAgent[] }> => {
  const now = Date.now();
  const running = targets.filter((task) => task.status === "pending");
  const settled = targets.filter((task) => task.status !== "pending");
  // An unread report is handed over only if THIS call wins its row. No resume
  // can race it — a resume needs the turn slot this turn holds — but the
  // guard costs nothing. A report read before comes back as it is: only a
  // call that named it asks for it.
  const unread = settled.filter((task) => task.consumedAt === null);
  const reread = settled.filter((task) => task.consumedAt !== null);
  const claimed = await consumeConversationTasks({
    conversationId,
    kind: "sub_agent",
    refs: unread.map((task) => task.ref),
  });
  const claimedRefs = new Set(claimed.map((task) => task.ref));
  return {
    running: running.map((task) => runningOf(task, now)),
    finished: [
      ...settled.filter((task) => claimedRefs.has(task.ref)),
      ...reread,
    ].map(finishedOf),
  };
};

const waitBudgetMs = (ctx: AgentRuntimeContext): number =>
  ctx.workflowRunId !== undefined
    ? subAgentDeadlineMs() + 60_000
    : CHAT_WAIT_MAX_MS;

const execute = async (
  input: ManageAgentsInput,
  options: ToolExecutionOptions<unknown>,
): Promise<ManageAgentsOutput | ToolErrorOutput> => {
  const ctx = getRuntimeContext(options);
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) {
    return toolError(
      TOOL_ERROR_CODES.NO_CONVERSATION,
      "No conversation, so no sub-agents.",
    );
  }
  const inWorkflow = ctx.workflowRunId !== undefined;
  const { action } = input;

  if (action === "stop") {
    const asked = await requestSubAgentStop({
      conversationId,
      by: "parent",
      ...(input.agentIds !== undefined
        ? { agentIds: input.agentIds }
        : { all: true as const }),
    });
    // Give the runs a moment to settle, so what they had done comes back now.
    // A stop by the parent settles quietly (consumed by the run itself), so
    // their rows are read, not consumed.
    const deadline = Date.now() + STOP_SETTLE_MS;
    let rows = await listSubAgentTasks(conversationId, asked);
    while (
      rows.some((task) => task.status === "pending") &&
      Date.now() < deadline &&
      !options.abortSignal?.aborted
    ) {
      await pause(500, options.abortSignal);
      rows = await listSubAgentTasks(conversationId, asked);
    }
    const now = Date.now();
    return {
      action,
      running: rows
        .filter((task) => task.status === "pending")
        .map((task) => runningOf(task, now)),
      finished: rows
        .filter((task) => task.status !== "pending")
        .map(finishedOf),
      next:
        asked.length === 0
          ? "None of them was running — nothing to stop."
          : "Stopped. Anything listed under `running` is stopping and will not report.",
    };
  }

  if (action === "wait") {
    const deadline = Date.now() + waitBudgetMs(ctx);
    let targets = await targetsOf(conversationId, input.agentIds);
    while (
      targets.some((task) => task.status === "pending") &&
      Date.now() < deadline &&
      !options.abortSignal?.aborted
    ) {
      await pause(POLL_MS, options.abortSignal);
      targets = await targetsOf(conversationId, input.agentIds);
    }
    const { running, finished } = await collect(conversationId, targets);
    return {
      action,
      running,
      finished,
      ...(running.length > 0
        ? {
            next: inWorkflow
              ? "Still running at the end of the wait. Wait again, or stop them and do the rest yourself."
              : "Still running. End your turn now: you are resumed with their reports when the last one finishes.",
          }
        : targets.length === 0
          ? { next: "No sub-agent to wait for." }
          : {}),
    };
  }

  const targets = await targetsOf(conversationId, input.agentIds);
  const { running, finished } = await collect(conversationId, targets);
  return {
    action,
    running,
    finished,
    ...(running.length > 0
      ? {
          next: inWorkflow
            ? "Work that does not need them? Do it. Otherwise `wait`."
            : "Work that does not need them? Do it. Otherwise end your turn: you are resumed with their reports.",
        }
      : targets.length === 0
        ? {
            next: "No sub-agent is running and every report has been handed over.",
          }
        : {}),
  };
};

export const createManageAgentsTool = () =>
  buildChatbotTool({
    category: "core",
    searchHint:
      "sub-agents status progress wait reports finished running stop cancel",
    // It hands over reports — the parent's only copy of that work — so it is
    // never compacted away.
    isReadOnly: false,
    description: [
      "Your sub-agents: where they stand (`status`), waiting for their reports (`wait`), stopping them (`stop`). Each report is handed over once — here or when you are resumed.",
      "`stop` when the user asks, or when what they are doing no longer serves the task. Never `status` in a loop to wait: `wait` does it without spending steps.",
    ].join("\n"),
    inputSchema: manageAgentsInputSchema,
    execute,
  });
