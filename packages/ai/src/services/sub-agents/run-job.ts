import type {
  SubAgentStopper,
  SubAgentTaskState,
} from "@fretik/shared/db/schema";
import { SUB_AGENT_STOPPERS } from "@fretik/shared/db/schema";
import { publishConversationTaskResume } from "@fretik/shared/lib/conversation-task-resume";
import { subscribeChannel } from "@fretik/shared/lib/redis-subscriber";
import { subAgentAbortChannel } from "@fretik/shared/lib/sub-agent-abort";
import {
  beatSubAgent,
  clearSubAgentHeartbeat,
  SUB_AGENT_HEARTBEAT_INTERVAL_MS,
} from "@fretik/shared/lib/sub-agent-heartbeat";
import { completeConversationTask } from "@fretik/shared/services/conversation-tasks/complete";
import { listSubAgentTasks } from "@fretik/shared/services/conversation-tasks/list";
import { patchConversationTaskMetadata } from "@fretik/shared/services/conversation-tasks/patch-metadata";
import { releasePythonContext } from "@fretik/shared/services/e2b/release-python-context";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Agent, ToolSet } from "ai";
import type { ChatbotCallOptions } from "../../agents/chatbot/call-options";
import { DynamicToolManager } from "../../agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../agents/shared/runtime-context";
import {
  createSubAgentRunner,
  type SubAgentToolCall,
} from "../../agents/shared/sub-agent";
import type { ModelProfile } from "../../lib/model-registry/types";
import { withNamedTrace } from "../../lib/trace-tool";
import { forgetTurnUsage, readTurnUsage } from "../../lib/turn-usage";
import type { SubAgentJobData } from "./queue";
import {
  activityOf,
  PROGRESS_ACTIVITY_ENTRIES,
  reportOfDeadline,
  reportOfRun,
  reportOfStop,
  subAgentDeadlineMs,
  type SubAgentReport,
} from "./report";

/**
 * One sub-agent, run by a queue worker — on whichever AI replica picked the
 * job up, with nothing of the turn that launched it but what the job carries.
 *
 * What the run owns, since no turn owns it:
 *  - its TASK ROW: the authority on whether it should run at all (a stop
 *    requested while it queued, an earlier attempt that already settled it),
 *    fed its live state for the chat card, and settled with the report and
 *    the terminal status in one write;
 *  - its STOP CHANNEL: subscribed BEFORE the row is read, so a stop landing
 *    between the two is still heard;
 *  - its HEARTBEAT: how the sweep tells a run that is working from one whose
 *    process died (`shared/services/conversation-tasks/kinds.ts`);
 *  - its TRACE: a `sub-agent` root in the conversation's Langfuse session,
 *    outside the launching turn, which has usually ended;
 *  - its COST: its own ledger key (the job's `traceId`), written to the row
 *    with every live-state write and at the end, then dropped.
 *
 * What wakes the conversation: settling the LAST pending task of it, through
 * the same signal as a workflow run's end. A stop by the assistant or by the
 * Stop of the launching answer consumes the outcome instead — nobody is
 * waiting for news they caused.
 */

/** Floor between two live-state writes: a card redraw, not a log. */
const PROGRESS_WRITE_MIN_MS = 1_500;

export interface SubAgentJobDeps<TTools extends ToolSet> {
  /** The agent pair and profile for a registry key (`agents/chatbot/delegate.ts`). */
  resolve: (profileKey: string) => {
    primary: Agent<ChatbotCallOptions, TTools>;
    fallback: Agent<ChatbotCallOptions, TTools>;
    contextCeiling: number;
    profile: ModelProfile;
  };
}

const isStopper = (value: string): value is SubAgentStopper =>
  (SUB_AGENT_STOPPERS as readonly string[]).includes(value);

/** Run one job. Never throws: every outcome, including a crash, is settled. */
export const runSubAgentJob = async <TTools extends ToolSet>(
  data: SubAgentJobData,
  deps: SubAgentJobDeps<TTools>,
): Promise<void> =>
  context.with(ROOT_CONTEXT, () =>
    withNamedTrace(
      "sub-agent",
      {
        sessionId: data.conversationId,
        ...(data.userId !== undefined ? { userId: data.userId } : {}),
        tags: [`team:${data.teamId}`],
        metadata: {
          agentId: data.agentId,
          ...(data.parentTraceId !== undefined
            ? { parentTraceId: data.parentTraceId }
            : {}),
        },
      },
      () => execute(data, deps),
    ),
  );

const execute = async <TTools extends ToolSet>(
  data: SubAgentJobData,
  deps: SubAgentJobDeps<TTools>,
): Promise<void> => {
  const { agentId, conversationId } = data;
  const controller = new AbortController();
  let stoppedBy: SubAgentStopper | undefined;
  const unsubscribe = subscribeChannel(
    subAgentAbortChannel(agentId),
    (message) => {
      stoppedBy ??= isStopper(message) ? message : "user";
      controller.abort();
    },
  );

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = (await listSubAgentTasks(conversationId, [agentId]))[0];
    // Settled already — by an earlier attempt this one repeats, or by the
    // sweep — or deleted with its conversation. Nothing left to do.
    if (task === undefined || task.status !== "pending") return;

    const startedAt = Date.now();
    // A retried job starts over, so the previous attempt's log goes.
    const state: SubAgentTaskState = {
      ...task.metadata?.subAgent,
      startedAt,
      step: 0,
      activity: [],
    };
    stoppedBy ??= state.stopRequested;

    const beat = (): void => {
      void beatSubAgent(agentId).catch(() => undefined);
    };
    beat();
    heartbeat = setInterval(beat, SUB_AGENT_HEARTBEAT_INTERVAL_MS);

    const usageKey = data.callOptions.traceId;
    const spendNow = (): SubAgentTaskState["usage"] => {
      const spend = readTurnUsage(usageKey);
      return spend === undefined
        ? undefined
        : {
            costUsd: spend.total.costUsd,
            inputTokens: spend.total.inputTokens,
            outputTokens: spend.total.outputTokens,
            cacheReadTokens: spend.total.cacheReadTokens,
          };
    };

    let lastWriteAt = 0;
    const writeState = (): void => {
      lastWriteAt = Date.now();
      // Live spend rides every write: a workflow run budgets it mid-turn.
      const usage = spendNow();
      if (usage !== undefined) state.usage = usage;
      void patchConversationTaskMetadata({
        kind: "sub_agent",
        ref: agentId,
        metadata: { subAgent: { ...state } },
      }).catch((err: unknown) => {
        console.warn(
          `[sub-agent] ${agentId} progress write failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    };
    // Picked up: the card leaves "starting", and the sweep now expects a
    // heartbeat from it.
    writeState();

    let toolCalls: readonly SubAgentToolCall[] = [];
    const onActivity = (
      calls: readonly SubAgentToolCall[],
      runStartedAt: number,
    ): void => {
      toolCalls = calls;
      state.step = calls.length;
      state.startedAt = runStartedAt;
      state.activity = activityOf(calls, PROGRESS_ACTIVITY_ENTRIES);
      const wait = PROGRESS_WRITE_MIN_MS - (Date.now() - lastWriteAt);
      if (wait <= 0) {
        writeState();
        return;
      }
      trailing ??= setTimeout(() => {
        trailing = undefined;
        writeState();
      }, wait);
    };

    let report: SubAgentReport;
    if (stoppedBy !== undefined) {
      // Stopped while it queued: it never starts.
      report = reportOfStop({ durationMs: 0, toolCalls: [] });
    } else {
      const set = deps.resolve(data.profileKey);
      const { run } = createSubAgentRunner<
        ChatbotCallOptions,
        TTools,
        SubAgentJobData,
        SubAgentReport
      >({
        subAgent: () => set.primary,
        fallbackSubAgent: () => set.fallback,
        contextCeiling: () => set.contextCeiling,
        // Its writes are sandbox files a rerun overwrites, never team data.
        hasSideEffect: () => false,
        buildMessages: () => [{ role: "user", content: data.brief }],
        buildCallOptions: () => data.callOptions,
        settle: async () => {
          void releasePythonContext(conversationId, agentId).catch(
            (err: unknown) => {
              console.warn(
                `[sub-agent] ${agentId} kernel release failed:`,
                err instanceof Error ? err.message : err,
              );
            },
          );
        },
        formatResult: (result, _salvaged, _usage, runInfo) =>
          reportOfRun(result, runInfo ?? { durationMs: 0, toolCalls: [] }),
        deadlineMs: subAgentDeadlineMs(),
        onDeadline: (_input, runInfo) => reportOfDeadline(runInfo),
      });
      try {
        report = await run(
          data,
          {
            toolCallId: agentId,
            messages: [],
            abortSignal: controller.signal,
            context: wrapRuntimeContext({
              organizationId: data.organizationId,
              teamId: data.teamId,
              ...(data.userId !== undefined ? { userId: data.userId } : {}),
              conversationId,
              traceId: data.callOptions.traceId,
              modelProfile: set.profile,
              dynamicToolManager: new DynamicToolManager(),
              agentKey: "sub-agent",
            }),
          },
          onActivity,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          report = reportOfStop({
            durationMs: Date.now() - startedAt,
            toolCalls,
          });
        } else {
          console.error(`[sub-agent] ${agentId} failed:`, err);
          report = {
            status: "failed",
            summary: `The sub-agent stopped on an unexpected error (${err instanceof Error ? err.message : String(err)}) and wrote no report.`,
            reason: "interrupted",
            toolCalls: toolCalls.length,
            durationMs: Date.now() - startedAt,
            activity: activityOf(toolCalls),
          };
        }
      }
    }
    if (trailing !== undefined) clearTimeout(trailing);

    const usage = spendNow();
    forgetTurnUsage(usageKey);

    // A stop the assistant made, or the one that ended its answer, is news to
    // nobody: settled AND consumed, so it never wakes the conversation.
    const quiet = stoppedBy === "parent" || stoppedBy === "turn";
    const { transitioned } = await completeConversationTask({
      kind: "sub_agent",
      ref: agentId,
      status:
        stoppedBy !== undefined
          ? "canceled"
          : report.status === "failed"
            ? "failed"
            : "succeeded",
      consume: quiet,
      metadata: {
        subAgent: {
          ...state,
          ...(stoppedBy !== undefined ? { stopRequested: stoppedBy } : {}),
          result: report,
          ...(usage !== undefined ? { usage } : {}),
        },
      },
    });
    // The conversation resumes once EVERY pending task is settled; this is
    // only "look now" — the resume's claim decides.
    if (transitioned && !quiet) {
      await publishConversationTaskResume(conversationId);
    }
  } catch (err) {
    // The row stays pending with no heartbeat: the sweep settles it as failed
    // and resumes the conversation. The report is lost, the wait is not.
    console.error(`[sub-agent] ${agentId} could not record its outcome:`, err);
  } finally {
    unsubscribe();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (trailing !== undefined) clearTimeout(trailing);
    await clearSubAgentHeartbeat(agentId).catch(() => undefined);
  }
};
