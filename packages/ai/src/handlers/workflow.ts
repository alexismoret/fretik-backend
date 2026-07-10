import db from "@fretik/shared/db";
import type { Workflow, WorkflowRun } from "@fretik/shared/db/schema";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import { redis } from "@fretik/shared/lib/redis";
import { applyAntiBufferingHeaders } from "@fretik/shared/lib/sse-headers";
import { workflowAbortChannel } from "@fretik/shared/lib/workflow-abort";
import {
  WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS,
  WorkflowFinalizeRequestSchema,
  WorkflowTurnRequestSchema,
  WorkflowTurnResultSchema,
  WorkflowWaitTokenRequestSchema,
  currentWorkflowTask,
  type WorkflowRunUsage,
  type WorkflowTaskState,
  type WorkflowTurnResult,
} from "@fretik/shared/schemas/workflows";
import { approvalPendingId } from "@fretik/shared/services/ai/approval-pending";
import {
  loadConversationForAgent,
  saveMessage,
  saveMessages,
} from "@fretik/shared/services/ai/messages";
import { releaseSandbox } from "@fretik/shared/services/e2b/release-sandbox";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import { evaluateCircuitBreaker } from "@fretik/shared/services/workflows/evaluate-circuit-breaker";
import { finalizeRun } from "@fretik/shared/services/workflows/finalize-run";
import { getWorkflowRow } from "@fretik/shared/services/workflows/get";
import { getWorkflowRunRow } from "@fretik/shared/services/workflows/get-run";
import {
  heartbeatRun,
  setRunWaitToken,
} from "@fretik/shared/services/workflows/heartbeat-run";
import { notifySourceConversation } from "@fretik/shared/services/workflows/notify-source-conversation";
import { recordTurnResult } from "@fretik/shared/services/workflows/record-turn-result";
import { startCurrentTask } from "@fretik/shared/services/workflows/start-current-task";
import { startRunning } from "@fretik/shared/services/workflows/start-running";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import {
  convertToModelMessages,
  createUIMessageStream,
  isToolUIPart,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { randomUUIDv7 } from "bun";
import { streamSSE } from "hono/streaming";
import {
  assembleContextFragments,
  buildConversationAttachedFilesBlock,
  loadExternalApps,
} from "../agents/shared/fragments";
import { formatCurrentDate } from "../agents/shared/prompt-renderer";
import {
  getWorkflowAgentSet,
  type WorkflowCallOptions,
} from "../agents/workflow";
import { collectRunOutputs } from "../agents/workflow/collect-outputs";
import {
  buildPlaybookBlock,
  buildSteeringMessage,
} from "../agents/workflow/playbook-block";
import { flushLangfuse, langfuseEnabled } from "../lib/langfuse";
import {
  getProfileForRole,
  resolveChatModelForProfile,
} from "../lib/model-registry/resolve";
import {
  streamWithRetryThenFallback,
  withSoftTimeout,
} from "../lib/stream-errors";
import { triggerCallbackMiddleware } from "../middlewares/trigger-callback";
import { prepareModelMessages } from "../services/native-input";
import { runUnifiedRecall } from "../services/recall/recall";

/**
 * Trigger.dev-facing routes — the workflow engine's server side. The
 * orchestrator task (`@fretik/workflows`) drives a run as a loop of BOUNDED
 * turns over `POST /runs/:runId/turn`; each turn executes the workflow
 * agent for up to `WORKFLOW_TURN_MAX_STEPS` steps, persists its messages +
 * turn result atomically (the idempotency anchor), and reports a terminal
 * `result` event over SSE (heartbeats keep proxies alive during the model
 * loop).
 *
 * Idempotency contract: `workflow_runs.lastTurnIndex/lastTurnResult` are
 * committed WITH the turn's messages. A retried `turnIndex <=
 * lastTurnIndex` replays the recorded result without touching the model, so
 * network-level retries by the orchestrator are always safe.
 */

const logPrefix = "[workflow.turn]";

/** How many history messages feed the agent (same default as the chatbot;
 * compaction is not wired for workflow runs in V1 — turns are bounded and
 * the playbook re-grounds every turn). */
const WORKFLOW_HISTORY_LIMIT = 40;

/** Consecutive turns with zero tool calls AND zero task transitions before
 * the run is failed — the anti-stall guard behind `completeTask`. */
const WORKFLOW_MAX_NO_PROGRESS_TURNS = 2;

const taskStatusFingerprint = (tasks: WorkflowTaskState[]): string =>
  tasks.map((t) => `${t.key}:${t.status}`).join("|");

/**
 * Trailing visible text of the turn's LAST assistant message, taken only
 * from AFTER that message's last tool call — the final run summary once
 * every task is closed. An agent that narrates between tool calls
 * ("Checking X… <tool> Now Y… <tool> Done: <final answer>") should surface
 * only the true final answer, not every narration chunk concatenated.
 * Messages with no tool call use the whole text (nothing to be "after").
 */
const trailingAssistantText = (messages: UIMessage[]): string => {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return "";
  let lastToolIndex = -1;
  last.parts.forEach((part, index) => {
    if (isToolUIPart(part)) {
      lastToolIndex = index;
    }
  });
  const chunks: string[] = [];
  last.parts.forEach((part, index) => {
    if (index <= lastToolIndex) return;
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  });
  return chunks.join("\n").trim();
};

/**
 * Detect a tool paused on HITL approval: the turn's last assistant message
 * carries a tool part whose output is `{ status: "approval_pending",
 * approvalId }` — `python` (a `run_plan` plan or a gated `records.bulk_*`
 * write) or the workflow `askUserQuestion`. Matched by output SHAPE
 * (`approvalPendingId`) across all `tool-*` parts, never by tool name; mirrors
 * the agent stop conditions, read back from the persisted parts.
 */
const detectPendingApproval = (
  messages: UIMessage[],
): { approvalRequestId: string } | null => {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return null;
  for (const part of last.parts) {
    if (!part.type.startsWith("tool-")) continue;
    if (!("output" in part)) continue;
    const approvalId = approvalPendingId(part.output);
    if (approvalId !== null) return { approvalRequestId: approvalId };
  }
  return null;
};

const addUsage = (
  prev: WorkflowRunUsage,
  turn: LanguageModelUsage | undefined,
  turnIndex: number,
): WorkflowRunUsage => ({
  inputTokens: prev.inputTokens + (turn?.inputTokens ?? 0),
  outputTokens: prev.outputTokens + (turn?.outputTokens ?? 0),
  totalTokens: prev.totalTokens + (turn?.totalTokens ?? 0),
  turns: turnIndex,
});

/** Read the anti-stall counter persisted alongside the previous turn's
 * result (an extra jsonb key the protocol schema deliberately strips). */
const previousNoProgressTurns = (run: WorkflowRun): number => {
  const raw = run.lastTurnResult;
  if (raw === null || typeof raw !== "object") return 0;
  const value = raw.noProgressTurns;
  return typeof value === "number" ? value : 0;
};

/**
 * The steering user message is persisted BEFORE the model streams so
 * history replays deterministically. A crash-retry of the same turn must
 * not stack a duplicate — the message carries its turnIndex in metadata and
 * is reused when already present.
 */
const ensureSteeringMessage = async (params: {
  run: WorkflowRun;
  conversationId: string;
  history: UIMessage[];
  turnIndex: number;
  currentDate: string;
  activeMemoryBlock?: string;
  nudge: boolean;
  wrapUp: boolean;
}): Promise<UIMessage[]> => {
  const last = params.history.at(-1);
  if (
    last?.role === "user" &&
    last.metadata !== null &&
    typeof last.metadata === "object" &&
    (last.metadata as Record<string, unknown>).workflowTurnIndex ===
      params.turnIndex
  ) {
    return params.history;
  }
  const text = buildSteeringMessage({
    run: params.run,
    turnIndex: params.turnIndex,
    currentDate: params.currentDate,
    activeMemoryBlock: params.activeMemoryBlock,
    nudge: params.nudge,
    wrapUp: params.wrapUp,
  });
  const parts: UIMessage["parts"] = [{ type: "text", text }];
  const row = await saveMessage({
    conversationId: params.conversationId,
    role: "user",
    parts,
    metadata: { workflowTurnIndex: params.turnIndex },
    authorId: params.run.actingUserId,
  });
  return [
    ...params.history,
    {
      id: row?.id ?? randomUUIDv7(),
      role: "user",
      parts,
      metadata: { workflowTurnIndex: params.turnIndex },
    },
  ];
};

/** Union of the run's task tool hints, for step-0 pre-activation. */
const unionToolHints = (tasks: WorkflowTaskState[]): string[] => {
  const hints = new Set<string>();
  for (const task of tasks) {
    for (const hint of task.toolHints ?? []) hints.add(hint);
  }
  return [...hints];
};

interface TurnExecution {
  result: WorkflowTurnResult;
  noProgressTurns: number;
}

/**
 * Execute ONE bounded agent turn for a run and return the protocol result.
 * `emitTaskUpdate` fires on live task transitions so the SSE stream (and
 * through it the orchestrator's `metadata.set`) mirrors the timeline
 * without waiting for the turn to finish.
 */
const executeTurn = async (params: {
  run: WorkflowRun;
  workflow: Workflow;
  turnIndex: number;
  wrapUp: boolean;
  emitTaskUpdate: (taskStates: WorkflowTaskState[]) => void;
}): Promise<TurnExecution> => {
  const { run, workflow, turnIndex } = params;
  const conversationId = run.conversationId;
  if (conversationId === null) {
    throw new Error(`run ${run.id} has no conversation`);
  }
  const actingUserId = run.actingUserId ?? undefined;
  const traceId = randomUUIDv7();

  // ---- Context assembly (fragments shared with the chatbot) ----
  const historyRaw = await loadConversationForAgent(
    conversationId,
    WORKFLOW_HISTORY_LIMIT,
  );
  const isFirstTurn = turnIndex === 1;
  const nudge = previousNoProgressTurns(run) > 0;

  // Harness-owned cursor stamp: the current task flips to `in_progress`
  // BEFORE the model runs — the timeline's "started" edge never depends on
  // the model. Refresh the run's task snapshot with the stamped state.
  const startedTask = await startCurrentTask({ runId: run.id });
  const taskStates = run.taskStates.map((t) =>
    startedTask !== null && t.key === startedTask.key ? startedTask : t,
  );
  const runForPrompt: WorkflowRun = { ...run, taskStates };
  params.emitTaskUpdate(taskStates);

  const [fragments, externalApps, recall, attachedFilesBlock] =
    await Promise.all([
      assembleContextFragments({
        organizationId: run.organizationId,
        teamId: run.teamId,
        userId: actingUserId,
        logPrefix,
      }),
      loadExternalApps({
        conversationId,
        organizationId: run.organizationId,
        teamId: run.teamId,
        userId: actingUserId,
        turnId: traceId,
        logPrefix,
      }),
      // Memory recall on the FIRST turn only. It rides in turn 1's steering
      // message (NOT the system prompt, which is byte-stable per run) and then
      // persists via the replayed message history — later turns re-render from
      // the same inputs would re-pay the judge for nothing.
      isFirstTurn && actingUserId !== undefined
        ? propagateAttributes(
            {
              traceName: "active-memory-recall",
              sessionId: conversationId,
              userId: actingUserId,
              tags: [`team:${run.teamId}`],
            },
            () =>
              withSoftTimeout(
                runUnifiedRecall({
                  userMessage: `${workflow.name}\n${workflow.playbook.goal}`,
                  attachedFiles: [],
                  recentTail: JSON.stringify(run.triggerPayload).slice(0, 2000),
                  teamId: run.teamId,
                  organizationId: run.organizationId,
                  userId: actingUserId,
                  conversationId,
                  agentType: "workflow",
                }),
                18000,
                null,
                "active-memory",
              ),
          )
        : Promise.resolve(null),
      // Files handed to the run (form/email trigger uploads) → `<file_attachments>`.
      buildConversationAttachedFilesBlock(conversationId),
    ]);

  // Steering carries everything that mutates per turn (date, live statuses,
  // current-task pin, turn-1 recall) so the system prompt stays byte-stable.
  // Workflows have no browser timezone → UTC, matching the prior prompt date.
  const history = await ensureSteeringMessage({
    run: runForPrompt,
    conversationId,
    history: historyRaw,
    turnIndex,
    currentDate: formatCurrentDate(new Date(), undefined),
    activeMemoryBlock: recall?.block ?? undefined,
    nudge,
    wrapUp: params.wrapUp,
  });

  const callOptions: WorkflowCallOptions = {
    organizationId: run.organizationId,
    teamId: run.teamId,
    userId: actingUserId,
    conversationId,
    traceId,
    workflowRunId: run.id,
    workflowAutonomy: workflow.autonomy,
    playbookBlock: buildPlaybookBlock(workflow, runForPrompt),
    toolHints: unionToolHints(run.taskStates),
    chatbotContextManifest: fragments.chatbotContextManifest,
    teamObjectsBlock: fragments.teamObjectsBlock,
    enabledSkillsBlock: fragments.enabledSkillsBlock,
    externalAppConnections: externalApps.externalAppConnections,
    externalAppsBlock: externalApps.externalAppsBlock,
    ...(attachedFilesBlock ? { attachedFilesBlock } : {}),
  };

  // ---- Stop plumbing (the user's Stop button → cancel-run publishes) ----
  const abortController = new AbortController();
  const abortSubscriber = redis.duplicate();
  await abortSubscriber.subscribe(workflowAbortChannel(run.id));
  abortSubscriber.on("message", () => {
    console.info(`${logPrefix} stop signal received run=${run.id}`);
    abortController.abort();
  });

  const agentSet = getWorkflowAgentSet(workflow.modelProfileKey ?? undefined);

  let turnUsage: LanguageModelUsage | undefined;
  let finalMessages: UIMessage[] = [];
  let toolCallCount = 0;

  // ---- Mid-turn token-budget enforcement ----
  // `stopWhen` can't read the per-run budget (it gets only `{ steps }`, and the
  // agent is a singleton), so enforce via abort in `onStepFinish`: accumulate
  // per-step usage and stop the turn the moment the run total crosses the
  // ceiling — not only at the turn boundary. Some providers under-report
  // per-step `totalTokens` (MiniMax); the end-of-turn check below is the
  // authoritative fallback for those.
  const tokenBudget =
    workflow.limits.maxTotalTokens ?? WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS;
  let turnAccumTokens = 0;
  let budgetAborted = false;
  const onWorkflowStepFinish = (step: {
    toolCalls: readonly unknown[];
    usage?: { totalTokens?: number };
  }): void => {
    toolCallCount += step.toolCalls.length;
    turnAccumTokens += step.usage?.totalTokens ?? 0;
    if (
      !budgetAborted &&
      run.usage.totalTokens + turnAccumTokens > tokenBudget
    ) {
      budgetAborted = true;
      console.warn(`${logPrefix} token budget exceeded mid-turn run=${run.id}`);
      abortController.abort();
    }
  };

  const modelProfile =
    workflow.modelProfileKey !== null
      ? resolveChatModelForProfile(workflow.modelProfileKey).profile
      : getProfileForRole("workflow");

  try {
    const modelMessages = await convertToModelMessages(
      await prepareModelMessages(history, modelProfile, {
        conversationId,
        readSessionFile,
        presignSessionFile: getSessionFilePresignedUrl,
      }),
      // Same dangling-tool-call guard as the chatbot — an interrupted
      // turn's incomplete tool call must not reach the model resultless.
      { ignoreIncompleteToolCalls: true },
    );

    const streamOutcome = await streamWithRetryThenFallback({
      primary: () =>
        agentSet.primary.stream({
          messages: modelMessages,
          options: callOptions,
          abortSignal: abortController.signal,
          onStepFinish: onWorkflowStepFinish,
        }),
      fallback: () =>
        agentSet.fallback.stream({
          messages: modelMessages,
          options: callOptions,
          abortSignal: abortController.signal,
          onStepFinish: onWorkflowStepFinish,
        }),
      abortSignal: abortController.signal,
      log: (message) => console.warn(`${logPrefix} ${message}`),
    });
    const result = streamOutcome.result;

    // Consume the UIMessage stream fully server-side; `onFinish` gives the
    // turn's final UIMessages for persistence (same shape the chat UI and
    // the next turn's history loader expect).
    const uiStream = createUIMessageStream<UIMessage>({
      originalMessages: history,
      onError: (err) =>
        err instanceof Error ? err.message : "workflow turn stream error",
      onFinish: ({ messages }) => {
        finalMessages = messages;
      },
      execute: ({ writer }) => {
        writer.merge(result.toUIMessageStream<UIMessage>());
      },
    });
    const reader = uiStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Live timeline mirror: completeTask tool results carry the fresh
      // task snapshot — forward it without waiting for the turn to end.
      if (
        typeof value === "object" &&
        "type" in value &&
        value.type === "tool-output-available"
      ) {
        const output: unknown = "output" in value ? value.output : undefined;
        if (
          output !== null &&
          typeof output === "object" &&
          "taskStates" in output &&
          Array.isArray((output as { taskStates: unknown }).taskStates)
        ) {
          params.emitTaskUpdate(
            (output as { taskStates: WorkflowTaskState[] }).taskStates,
          );
        }
      }
    }
    turnUsage = await result.totalUsage;
  } finally {
    await abortSubscriber.quit().catch(() => undefined);
    // Pause the sandbox between turns — same billing discipline as chat.
    void releaseSandbox(conversationId).catch((err: unknown) => {
      console.warn(
        `${logPrefix} sandbox pause failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  // ---- Turn outcome ----
  const fresh = await getWorkflowRunRow({ id: run.id });
  const freshTasks = fresh?.taskStates ?? taskStates;
  const usage = addUsage(run.usage, turnUsage, turnIndex);
  const approval = abortController.signal.aborted
    ? null
    : detectPendingApproval(finalMessages);
  const progressed =
    taskStatusFingerprint(freshTasks) !== taskStatusFingerprint(run.taskStates);
  const noProgressTurns =
    progressed || toolCallCount > 0 ? 0 : previousNoProgressTurns(run) + 1;
  const allDone = currentWorkflowTask(freshTasks) === null;
  const anyFailed = freshTasks.some((t) => t.status === "failed");

  let result: WorkflowTurnResult;
  if (budgetAborted) {
    // A mid-turn budget abort also flips `signal.aborted`, so classify it
    // BEFORE the user-cancel branch — it's a run failure, not a cancel.
    result = {
      status: "failed",
      turnIndex,
      taskStates: freshTasks,
      usage,
      error: {
        code: "TOKEN_BUDGET",
        message: `Run exceeded its token budget (${usage.totalTokens.toString()} > ${tokenBudget.toString()}).`,
      },
    };
  } else if (abortController.signal.aborted) {
    result = {
      status: "canceled",
      turnIndex,
      taskStates: freshTasks,
      usage,
    };
  } else if (approval !== null) {
    result = {
      status: "needs_approval",
      turnIndex,
      taskStates: freshTasks,
      usage,
      approvalRequestId: approval.approvalRequestId,
    };
  } else if (allDone) {
    const summary = trailingAssistantText(finalMessages);
    result = {
      status: anyFailed ? "failed" : "completed",
      turnIndex,
      taskStates: freshTasks,
      usage,
      outputSummary: summary,
      ...(anyFailed
        ? {
            error: {
              code: "TASK_FAILED",
              message:
                freshTasks.find((t) => t.status === "failed")?.summary ??
                "A playbook task failed.",
            },
          }
        : {}),
    };
  } else if (noProgressTurns >= WORKFLOW_MAX_NO_PROGRESS_TURNS) {
    result = {
      status: "failed",
      turnIndex,
      taskStates: freshTasks,
      usage,
      error: {
        code: "NO_PROGRESS",
        message: `No tool call and no task transition for ${noProgressTurns.toString()} consecutive turns.`,
      },
    };
  } else if (usage.totalTokens > tokenBudget) {
    // Authoritative end-of-turn check — catches providers that under-report
    // per-step usage, where the mid-turn abort never fired.
    result = {
      status: "failed",
      turnIndex,
      taskStates: freshTasks,
      usage,
      error: {
        code: "TOKEN_BUDGET",
        message: `Run exceeded its token budget (${usage.totalTokens.toString()} > ${tokenBudget.toString()}).`,
      },
    };
  } else {
    result = { status: "continue", turnIndex, taskStates: freshTasks, usage };
  }

  // A finishing run's deliverables (files it surfaced via `presentFiles`)
  // become the run's first-class `outputs`. Scanned once, off the transaction
  // (a full-conversation read), only on a terminal outcome — canceled runs are
  // user-stopped and skipped. The finishing turn's messages are passed
  // in-memory: they are not committed yet, and "produce → present → close the
  // last task" in one turn is the normal pattern.
  const runOutputs =
    result.status === "completed" || result.status === "failed"
      ? await collectRunOutputs(conversationId, finalMessages)
      : undefined;

  // ---- Atomic persistence: messages + turn cursor (+ finalize) ----
  let terminal = false;
  await db.transaction(async (tx) => {
    const known = new Set(history.map((m) => m.id));
    const assistantMessages = finalMessages.filter(
      (m) => !known.has(m.id) && m.role === "assistant",
    );
    await saveMessages(
      conversationId,
      assistantMessages.map((m) => ({
        role: "assistant" as const,
        parts: m.parts,
        metadata:
          m.metadata && typeof m.metadata === "object"
            ? (m.metadata as Record<string, unknown>)
            : undefined,
      })),
      tx,
    );
    await recordTurnResult({
      tx,
      runId: run.id,
      result: { ...result, noProgressTurns } as WorkflowTurnResult,
    });
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "canceled"
    ) {
      await finalizeRun({
        tx,
        runId: run.id,
        status: result.status === "completed" ? "succeeded" : result.status,
        outputSummary: result.outputSummary ?? null,
        ...(runOutputs !== undefined ? { outputs: runOutputs } : {}),
        error: result.error ?? null,
        usage,
      });
      terminal = true;
    }
  });

  // Post the completion notice to the launching chat AFTER the commit (never
  // inside the tx — a rolled-back finalize must not leave a stray message).
  // Idempotent + fire-and-forget: a failed notice must not fail the turn.
  if (terminal) {
    void notifySourceConversation({ runId: run.id }).catch((err: unknown) => {
      console.warn(
        `${logPrefix} source-conversation notice failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  return { result, noProgressTurns };
};

// ==================== //
// ROUTES               //
// ==================== //

export const workflowTriggerRoutes = new OpenAPIHono();
workflowTriggerRoutes.use("*", triggerCallbackMiddleware);

/**
 * POST /internal/trigger/runs/:runId/turn — execute one turn. SSE response:
 * `heartbeat` every 10 s while the model loop runs, best-effort
 * `task-update` events on live transitions, then exactly one terminal
 * `result` event carrying the `WorkflowTurnResult`.
 */
workflowTriggerRoutes.post("/runs/:runId/turn", async (c) => {
  const runId = c.req.param("runId");
  const parsed = WorkflowTurnRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", message: "Invalid body" }, 400);
  }
  const { turnIndex, wrapUp } = parsed.data;

  const run = await getWorkflowRunRow({ id: runId });
  if (!run) {
    return c.json({ code: "NOT_FOUND", message: "Run not found" }, 404);
  }
  const workflow = await getWorkflowRow({
    id: run.workflowId,
    teamId: run.teamId,
  });
  if (!workflow) {
    return c.json({ code: "NOT_FOUND", message: "Workflow not found" }, 404);
  }

  applyAntiBufferingHeaders(c);
  return streamSSE(
    c,
    async (stream) => {
      const send = async (event: string, data: unknown): Promise<void> => {
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      const heartbeat = setInterval(() => {
        void send("heartbeat", { ts: Date.now() });
      }, 10_000);
      // DB liveness stamp — kept fresh through a long turn (a turn may run up
      // to the run's whole wall-clock budget) so the 20-min stall sweeper
      // never reclaims a run that is legitimately still working. The initial
      // stamp below covers short turns; this covers the long ones.
      const dbHeartbeat = setInterval(() => {
        void heartbeatRun({ runId }).catch(() => undefined);
      }, 60_000);

      try {
        // Replay path: the previous attempt committed but its response was
        // lost — return the recorded verdict without touching the model.
        if (run.lastTurnIndex >= turnIndex) {
          const replayed = WorkflowTurnResultSchema.safeParse(
            run.lastTurnResult,
          );
          await send(
            "result",
            replayed.success
              ? replayed.data
              : {
                  status: "failed",
                  turnIndex,
                  taskStates: run.taskStates,
                  usage: run.usage,
                  error: {
                    code: "REPLAY_CORRUPT",
                    message: "Recorded turn result is unreadable.",
                  },
                },
          );
          return;
        }
        // Terminal runs answer terminally (e.g. canceled mid-loop).
        if (
          run.status === "succeeded" ||
          run.status === "failed" ||
          run.status === "canceled"
        ) {
          await send("result", {
            status: run.status === "succeeded" ? "completed" : run.status,
            turnIndex,
            taskStates: run.taskStates,
            usage: run.usage,
          });
          return;
        }

        await heartbeatRun({ runId });

        // Honest status: flip `queued → running` at the START of turn 1, not
        // only when its result is recorded — so `get_run` / the run page show
        // real progress from the first seconds, and the stall sweeper (which
        // scans only `running`) covers a turn-1 crash. Idempotent on replay.
        if (turnIndex === 1) await startRunning({ runId });

        const emitTaskUpdate = (taskStates: WorkflowTaskState[]): void => {
          void send("task-update", { taskStates });
        };

        const runTurn = (): Promise<TurnExecution> =>
          executeTurn({
            run,
            workflow,
            turnIndex,
            wrapUp: wrapUp ?? false,
            emitTaskUpdate,
          });

        let execution: TurnExecution;
        if (!langfuseEnabled) {
          execution = await runTurn();
        } else {
          execution = await startActiveObservation("workflow-turn", async () =>
            propagateAttributes(
              {
                traceName: "workflow-turn",
                sessionId: run.conversationId ?? run.id,
                ...(run.actingUserId !== null
                  ? { userId: run.actingUserId }
                  : {}),
                tags: [`team:${run.teamId}`, `workflow:${run.workflowId}`],
                metadata: {
                  teamId: run.teamId,
                  organizationId: run.organizationId,
                  workflowRunId: run.id,
                  turnIndex: turnIndex.toString(),
                },
              },
              async () => {
                updateActiveObservation(
                  { input: `${workflow.name} — turn ${turnIndex.toString()}` },
                  { asType: "agent" },
                );
                return runTurn();
              },
            ),
          );
          await flushLangfuse();
        }

        await send("result", execution.result);
        // A failed run may have pushed this workflow past its consecutive-
        // failure limit — auto-pause it (safety net, fire-and-forget).
        if (execution.result.status === "failed") {
          void evaluateCircuitBreaker({ runId }).catch((err: unknown) => {
            console.warn(
              `${logPrefix} circuit-breaker check failed run=${runId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "turn error";
        console.error(
          `${logPrefix} turn failed run=${runId} turn=${turnIndex.toString()}:`,
          error instanceof Error ? error.message : error,
        );
        // The turn threw before its own atomic persistence committed, so the
        // run is still `running`. Close it NOW (idempotent) instead of leaving
        // a zombie for the 20-min stall sweeper — and with the RIGHT code.
        await finalizeRun({
          runId,
          status: "failed",
          error: { code: "TURN_ERROR", message },
        }).catch((err: unknown) => {
          console.error(
            `${logPrefix} finalize-on-error failed run=${runId}:`,
            err instanceof Error ? err.message : err,
          );
        });
        void evaluateCircuitBreaker({ runId }).catch(() => undefined);
        await send("result", {
          status: "failed",
          turnIndex,
          taskStates: run.taskStates,
          usage: run.usage,
          error: { code: "TURN_ERROR", message },
        });
      } finally {
        clearInterval(heartbeat);
        clearInterval(dbHeartbeat);
      }
    },
    async (err, stream) => {
      console.error(`${logPrefix} SSE error:`, err);
      await stream.close();
    },
  );
});

/** POST /internal/trigger/runs/:runId/wait-token — record the approval wait
 * token the orchestrator parked on. */
workflowTriggerRoutes.post("/runs/:runId/wait-token", async (c) => {
  const runId = c.req.param("runId");
  const parsed = WorkflowWaitTokenRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", message: "Invalid body" }, 400);
  }
  await setRunWaitToken({ runId, waitTokenId: parsed.data.waitTokenId });
  return c.json({ ok: true }, 200);
});

/** POST /internal/trigger/runs/:runId/finalize — terminal close from the
 * orchestrator (`onFailure`, deadline, approval timeout). Idempotent. */
workflowTriggerRoutes.post("/runs/:runId/finalize", async (c) => {
  const runId = c.req.param("runId");
  const parsed = WorkflowFinalizeRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", message: "Invalid body" }, 400);
  }
  await finalizeRun({
    runId,
    status: parsed.data.status,
    error: parsed.data.error ?? null,
  });
  // Notify the launching chat for orchestrator-side terminal closes too
  // (deadline, approval timeout, onFailure) — idempotent with the turn-close path.
  void notifySourceConversation({ runId }).catch(() => undefined);
  // Orchestrator-side terminal failures (onFailure, deadline, approval timeout)
  // feed the circuit breaker too.
  if (parsed.data.status === "failed") {
    void evaluateCircuitBreaker({ runId }).catch(() => undefined);
  }
  return c.json({ ok: true }, 200);
});

/**
 * POST /internal/trigger/workflows/:workflowId/cron-fire — the shared
 * `workflow-cron` scheduled task looks the workflow up by externalId and
 * fires a run through the single creation seam. Guards: workflow must be
 * ACTIVE with a cron trigger, and a run already queued/running for it skips
 * (an hour-long run must not stack hourly duplicates).
 */
workflowTriggerRoutes.post("/workflows/:workflowId/cron-fire", async (c) => {
  const workflowId = c.req.param("workflowId");
  const workflow = await db.query.workflows.findFirst({
    where: { id: workflowId },
  });
  if (!workflow) {
    return c.json({ code: "NOT_FOUND", message: "Workflow not found" }, 404);
  }
  if (workflow.status !== "active" || workflow.triggerType !== "cron") {
    return c.json({ fired: false, reason: "not-active-cron" }, 200);
  }
  const inFlight = await db.query.workflowRuns.findFirst({
    where: {
      workflowId,
      status: { in: ["queued", "running", "needs_approval"] },
    },
    columns: { id: true },
  });
  if (inFlight) {
    return c.json({ fired: false, reason: "run-in-flight" }, 200);
  }
  const run = await createWorkflowRun({
    workflow,
    triggerType: "cron",
  });
  return c.json({ fired: true, runId: run.id }, 200);
});
