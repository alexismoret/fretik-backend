import type {
  SubAgentTaskActivity,
  SubAgentTaskResult,
  SubAgentTaskState,
} from "@fretik/shared/db/schema";
import { publishConversationTaskResume } from "@fretik/shared/lib/conversation-task-resume";
import {
  beatSubAgent,
  clearSubAgentHeartbeat,
  SUB_AGENT_HEARTBEAT_INTERVAL_MS,
} from "@fretik/shared/lib/sub-agent-heartbeat";
import { completeConversationTask } from "@fretik/shared/services/conversation-tasks/complete";
import { patchConversationTaskMetadata } from "@fretik/shared/services/conversation-tasks/patch-metadata";
import { registerConversationTask } from "@fretik/shared/services/conversation-tasks/register";
import { context, ROOT_CONTEXT } from "@opentelemetry/api";
import type { SubAgentToolCall } from "../../agents/shared/sub-agent";
import { withNamedTrace } from "../../lib/trace-tool";
import { forgetTurnUsage, readTurnUsage } from "../../lib/turn-usage";

/**
 * A sub-agent that runs AFTER its tool call returned — `dispatchAgent` with
 * `background: true`.
 *
 * The foreground dispatch holds the parent's step until the report is back:
 * the AI SDK runs a step's tool calls together and waits for all of them
 * before the next model call, so the parent can do nothing else meanwhile,
 * and a twenty-minute run holds the whole turn — and the user — for twenty
 * minutes. In the background, the tool answers at once, the parent keeps
 * working, and when it needs the report it ENDS ITS TURN: the conversation
 * resumes itself once every run it launched has finished, through the same
 * wait registry a workflow run launched from the chat uses
 * (`conversation_background_tasks`, `services/conversation-tasks/*`). That is
 * the whole mechanism — the turn-end "pause" is the resume the product
 * already had, not a new one.
 *
 * What the run owns, since no turn owns it any more:
 *  - its TASK ROW: registered before the tool answers (so a turn ending right
 *    after sees it pending), fed live state for the chat card, and settled
 *    with the report in the same write;
 *  - its HEARTBEAT: the sweep reads a lapsed one as a process that died
 *    mid-run and settles the row as failed, so a deploy cannot leave a
 *    conversation waiting forever (`shared/lib/sub-agent-heartbeat.ts`);
 *  - its TRACE: a `sub-agent` root in the conversation's Langfuse session,
 *    detached from the turn that launched it, which has usually ended;
 *  - its COST: its own ledger key (see `backgroundTraceId`), read into the
 *    row and dropped at the end.
 *
 * In this process, not a durable queue, on purpose: the run needs the
 * parent's live context (tool policies, apps, the rendered brief) that only
 * this process holds, and a Trigger.dev task could only call back into this
 * same service over HTTP — it would add a hop and a protocol to buy an
 * automatic retry of a read-only job, where the heartbeat already turns a
 * lost run into a visible, re-dispatchable failure.
 */

/**
 * The trace id a background run is known by: its own ledger key and its own
 * provider lane. No dot, so `turnRootOf` keeps it whole instead of folding it
 * into the launching turn, whose ledger entry is gone by the time it finishes.
 */
export const backgroundTraceId = (agentId: string): string =>
  `subagent-${agentId}`;

/** Floor between two live-state writes: a card redraw, not a log. */
const PROGRESS_WRITE_MIN_MS = 1_500;

export interface BackgroundRunHooks {
  /** Feed every tool call the run starts or settles. */
  onActivity: (
    toolCalls: readonly SubAgentToolCall[],
    startedAt: number,
  ) => void;
}

export interface StartBackgroundRunParams {
  agentId: string;
  conversationId: string;
  /** The 3-6 words the parent gave it — the task row's title. */
  title: string;
  /** What is known at launch: who, from which call, on which model. */
  state: SubAgentTaskState;
  trace: { userId?: string; teamId: string; parentTraceId?: string };
  /** How a call log is shown on the card (the tool owns that choice). */
  activityOf: (
    toolCalls: readonly SubAgentToolCall[],
  ) => SubAgentTaskActivity[];
  /** The run itself. Resolves to its report; a throw settles it as failed. */
  execute: (hooks: BackgroundRunHooks) => Promise<SubAgentTaskResult>;
}

/**
 * Register the run, then start it detached. Resolves once the row exists —
 * never with the run's outcome, which lands on the row and wakes the
 * conversation.
 */
export const startBackgroundRun = async (
  params: StartBackgroundRunParams,
): Promise<void> => {
  await registerConversationTask({
    conversationId: params.conversationId,
    kind: "sub_agent",
    ref: params.agentId,
    title: params.title,
    metadata: { subAgent: params.state },
  });
  // Out of the launching turn's trace and out of its promise chain: the turn
  // ends long before this does, and its span must not be this run's parent.
  void context
    .with(ROOT_CONTEXT, () =>
      withNamedTrace(
        "sub-agent",
        {
          sessionId: params.conversationId,
          ...(params.trace.userId !== undefined
            ? { userId: params.trace.userId }
            : {}),
          tags: [`team:${params.trace.teamId}`, "background"],
          metadata: {
            agentId: params.agentId,
            ...(params.trace.parentTraceId !== undefined
              ? { parentTraceId: params.trace.parentTraceId }
              : {}),
          },
        },
        () => runDetached(params),
      ),
    )
    .catch((err: unknown) => {
      console.error(
        `[sub-agent:background] ${params.agentId} escaped its own guard:`,
        err,
      );
    });
};

const runDetached = async (params: StartBackgroundRunParams): Promise<void> => {
  const { agentId, conversationId } = params;
  const state: SubAgentTaskState = { ...params.state };
  const launchedAt = Date.now();

  const beat = (): void => {
    void beatSubAgent(agentId).catch(() => undefined);
  };
  beat();
  const heartbeat = setInterval(beat, SUB_AGENT_HEARTBEAT_INTERVAL_MS);

  // Live state for the card: the newest snapshot wins, written at most every
  // PROGRESS_WRITE_MIN_MS, with a trailing write so the last one is not lost.
  let lastWriteAt = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const writeState = (): void => {
    lastWriteAt = Date.now();
    void patchConversationTaskMetadata({
      kind: "sub_agent",
      ref: agentId,
      metadata: { subAgent: { ...state } },
    }).catch((err: unknown) => {
      console.warn(
        `[sub-agent:background] ${agentId} progress write failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  };
  const onActivity: BackgroundRunHooks["onActivity"] = (
    toolCalls,
    startedAt,
  ) => {
    state.step = toolCalls.length;
    state.startedAt = startedAt;
    state.activity = params.activityOf(toolCalls);
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

  let result: SubAgentTaskResult;
  try {
    result = await params.execute({ onActivity });
  } catch (err) {
    console.error(`[sub-agent:background] ${agentId} failed:`, err);
    result = {
      status: "failed",
      summary: `The sub-agent stopped on an unexpected error (${err instanceof Error ? err.message : String(err)}) and wrote no report.`,
      reason: "interrupted",
      toolCalls: state.step ?? 0,
      durationMs: Date.now() - (state.startedAt ?? launchedAt),
      activity: state.activity ?? [],
    };
  } finally {
    clearInterval(heartbeat);
    if (trailing !== undefined) clearTimeout(trailing);
  }

  const usageKey = backgroundTraceId(agentId);
  const spend = readTurnUsage(usageKey);
  forgetTurnUsage(usageKey);

  try {
    const { transitioned } = await completeConversationTask({
      kind: "sub_agent",
      ref: agentId,
      status: result.status === "failed" ? "failed" : "succeeded",
      metadata: {
        subAgent: {
          ...state,
          result,
          ...(spend !== undefined
            ? {
                usage: {
                  costUsd: spend.total.costUsd,
                  inputTokens: spend.total.inputTokens,
                  outputTokens: spend.total.outputTokens,
                },
              }
            : {}),
        },
      },
    });
    // The conversation resumes once EVERY pending task is settled; the
    // signal is only "look now" — the claim decides.
    if (transitioned) await publishConversationTaskResume(conversationId);
  } catch (err) {
    // The row stays pending with no heartbeat: the sweep settles it as failed
    // and resumes the conversation. The report is lost, the wait is not.
    console.error(
      `[sub-agent:background] ${agentId} could not record its outcome:`,
      err,
    );
  } finally {
    await clearSubAgentHeartbeat(agentId).catch(() => undefined);
  }
};
