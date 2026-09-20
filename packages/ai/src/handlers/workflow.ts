import db from "@fretik/shared/db";
import type { Workflow, WorkflowRun } from "@fretik/shared/db/schema";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import { deterministicUuid } from "@fretik/shared/lib/deterministic-uuid";
import { applyAntiBufferingHeaders } from "@fretik/shared/lib/sse-headers";
import { workflowAbortChannel } from "@fretik/shared/lib/workflow-abort";
import {
  currentWorkflowTask,
  isNoOpOutcome,
  isTerminalRunStatus,
  WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS,
  WorkflowFinalizeRequestSchema,
  WorkflowTurnRequestSchema,
  WorkflowTurnResultSchema,
  WorkflowWaitTokenRequestSchema,
  type WorkflowRunUsage,
  type WorkflowTaskState,
  type WorkflowTurnResult,
} from "@fretik/shared/schemas/workflows";
import {
  clearConversationActiveStream,
  forceSetConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import { approvalPendingId } from "@fretik/shared/services/ai/approval-pending";
import { saveMessage, saveMessages } from "@fretik/shared/services/ai/messages";
import {
  endTurnLog,
  openTurnLog,
  pumpChunksToTurnLog,
} from "@fretik/shared/services/ai/turn-log";
import { releaseSandbox } from "@fretik/shared/services/e2b/release-sandbox";
import { getTeamToolPolicies } from "@fretik/shared/services/tool-policies/get-for-team";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import { evaluateCircuitBreaker } from "@fretik/shared/services/workflows/evaluate-circuit-breaker";
import { finalizeRun } from "@fretik/shared/services/workflows/finalize-run";
import { getWorkflowRow } from "@fretik/shared/services/workflows/get";
import { getWorkflowRunRow } from "@fretik/shared/services/workflows/get-run";
import {
  heartbeatRun,
  setRunWaitToken,
} from "@fretik/shared/services/workflows/heartbeat-run";
import { onWorkflowRunTerminal } from "@fretik/shared/services/workflows/on-run-terminal";
import { recordTurnResult } from "@fretik/shared/services/workflows/record-turn-result";
import { sendRunApprovalEmailIfEnabled } from "@fretik/shared/services/workflows/send-run-approval-email";
import { sendRunCompletionEmailIfEnabled } from "@fretik/shared/services/workflows/send-run-completion-email";
import { startCurrentTask } from "@fretik/shared/services/workflows/start-current-task";
import { startRunning } from "@fretik/shared/services/workflows/start-running";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import {
  convertToModelMessages,
  createUIMessageStream,
  isToolUIPart,
  toUIMessageStream,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { randomUUIDv7 } from "bun";
import { streamSSE } from "hono/streaming";
// node:stream/web rather than the DOM global — same typing rationale as
// `lib/scrub-stream.ts` (the DOM TransformStream doesn't unify with the
// AI SDK's stream iterator shape).
import { TransformStream } from "node:stream/web";
import { compactionCapForCeiling } from "../agents/shared/context-ceiling";
import {
  assembleContextFragments,
  buildConversationAttachedFilesBlock,
  loadExternalApps,
} from "../agents/shared/fragments";
import { formatCurrentDate } from "../agents/shared/prompt-renderer";
import { STANDING_MODE } from "../agents/shared/standing-memory";
import {
  getWorkflowAgentSet,
  type WorkflowCallOptions,
} from "../agents/workflow";
import { collectRunOutputs } from "../agents/workflow/collect-outputs";
import {
  buildPlaybookBlock,
  buildSteeringMessage,
} from "../agents/workflow/playbook-block";
import type { WorkflowTools } from "../agents/workflow/tools";
import { recallForWorkflowTurnOne } from "../agents/workflow/turn-one-memory";
import { subscribeAbort } from "../lib/abort-subscriber";
import { flushLangfuse, langfuseEnabled } from "../lib/langfuse";
import {
  effectiveReasoningLevel,
  reasoningParamForProfile,
  resolveChatModelForProfile,
} from "../lib/model-registry/resolve";
import { resolveTeamFlagship } from "../lib/model-registry/team-model";
import { buildSensitiveInputScrubber } from "../lib/scrub-stream";
import { streamWithRetryThenFallback } from "../lib/stream-errors";
import { dropNonTerminalErrorFrames } from "../lib/wire-errors";
import { triggerCallbackMiddleware } from "../middlewares/trigger-callback";
import {
  loadAgentWindow,
  persistCheckpoint,
} from "../services/compaction/checkpoint-window";
import {
  compactConversation,
  type CompactionArtifact,
} from "../services/compaction/compact";
import {
  hasNativeFileParts,
  NATIVE_FILE_PARSER_PLUGINS,
  prepareModelMessages,
} from "../services/native-input";
import {
  buildTurnMessageMetadata,
  filterNewAssistantMessages,
  narrowMessageMetadata,
} from "./turn-helpers";

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

/** How many history messages feed the agent (same default as the chatbot).
 *
 * This used to say that summarising compaction was not wired for runs because
 * "turns are bounded and the playbook re-grounds every turn". Both halves were
 * true and the conclusion was wrong: a bounded turn is bounded in STEPS, and 50
 * steps reached 200 480 tokens on 2026-09-17 while re-grounding the model on a
 * task it had already (wrongly) closed. `executeTurn` now runs the full
 * `compactConversation` between turns, capped at the context ceiling. */
const WORKFLOW_HISTORY_LIMIT = 40;

/** Consecutive turns with zero tool calls AND zero task transitions before
 * the run is failed — the anti-stall guard behind `completeTask`. */
const WORKFLOW_MAX_NO_PROGRESS_TURNS = 2;

/**
 * Consecutive turns that call tools but close NO task before the run is failed.
 *
 * Distinct from the counter above, which asks "is anything happening". Both
 * were the same question until 2026-09-17, when a run answered yes 51 times in
 * 40 minutes — tool calls all the way down, not one task transition — and the
 * stall guard stayed at zero the whole time. Deliberately looser than two: a
 * hard task legitimately spans turns, and this is a backstop against a run that
 * has stopped converging, not a pace requirement.
 */
const WORKFLOW_MAX_NO_TASK_TURNS = 6;

/** Share of the token budget that raises a warning while the run is still
 * stoppable. Below this nothing is said; at 100% the turn is aborted. */
const BUDGET_WARN_FRACTION = 0.8;

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

/**
 * Fold a finished turn into the run's usage.
 *
 * `turn` is `await result.usage`, which is only assigned when the stream ran to
 * completion. An ABORTED turn never reaches it — and the abort that matters
 * most is the token-budget one, so the turn that blew the budget was the one
 * turn missing from the total. On 2026-09-17 that printed
 * "Run exceeded its token budget (5589501 > 6000000)", an assertion that is
 * arithmetically false, while ~530 000 tokens went unbilled to the run.
 *
 * `floorTotalTokens` is the mid-turn accumulator from `onStepEnd`, which counts
 * whatever the turn spent before it was cut. A floor rather than a replacement:
 * per-step usage is a sum of what each step reported, `result.usage` is the
 * provider's own total, and where both exist the provider's is authoritative.
 * It only ever raises the total, never lowers it.
 */
export const addUsage = (
  prev: WorkflowRunUsage,
  turn: LanguageModelUsage | undefined,
  turnIndex: number,
  floorTotalTokens = 0,
): WorkflowRunUsage => ({
  inputTokens: prev.inputTokens + (turn?.inputTokens ?? 0),
  outputTokens: prev.outputTokens + (turn?.outputTokens ?? 0),
  totalTokens:
    prev.totalTokens + Math.max(turn?.totalTokens ?? 0, floorTotalTokens),
  cachedInputTokens:
    prev.cachedInputTokens + (turn?.inputTokenDetails.cacheReadTokens ?? 0),
  turns: turnIndex,
});

/** Read an anti-stall counter persisted alongside the previous turn's
 * result (extra jsonb keys the protocol schema deliberately strips). */
const previousCounter = (
  run: WorkflowRun,
  key: "noProgressTurns" | "noTaskTurns",
): number => {
  const raw = run.lastTurnResult;
  if (raw === null || typeof raw !== "object") return 0;
  const value = raw[key];
  return typeof value === "number" ? value : 0;
};

/**
 * The steering user message is persisted BEFORE the model streams so history
 * replays deterministically. A crash-retry of the same turn must not stack a
 * duplicate — which is what its **deterministic id** guarantees: one row per
 * `(conversation, turnIndex)`, and `saveMessage`'s upsert rewrites it in place
 * on a replay, keeping its `seq` and its `created_at`.
 *
 * It used to dedup by reading `history.at(-1)` and looking for a matching
 * `workflowTurnIndex`, and that check was already unsound before any
 * checkpoint existed: when compaction fires it REPLACES the history with the
 * summary (plus the activation replay), neither of which carries a
 * `workflowTurnIndex` — so a turn replayed after a compaction stacked a second
 * steering message with a fresh id every time. An id that states the fact is
 * stronger than a read that tries to infer it.
 */
const ensureSteeringMessage = async (params: {
  run: WorkflowRun;
  conversationId: string;
  history: UIMessage[];
  turnIndex: number;
  currentDate: string;
  activeMemoryBlock?: string;
  memoryIndexBlock?: string;
  standingMemoryBlock?: string;
  nudge: boolean;
  wrapUp: boolean;
}): Promise<UIMessage[]> => {
  const steeringId = deterministicUuid(
    `workflow-steering:${params.conversationId}:${params.turnIndex.toString()}`,
  );
  // Already in the window? Then this is a replay of a turn whose steering
  // message is still where it was, and re-writing it would only churn bytes
  // the provider cache is holding. Matched by ID, so it is found wherever it
  // sits in the window rather than only at the end.
  if (params.history.some((m) => m.id === steeringId)) {
    return params.history;
  }
  const text = buildSteeringMessage({
    run: params.run,
    turnIndex: params.turnIndex,
    currentDate: params.currentDate,
    activeMemoryBlock: params.activeMemoryBlock,
    memoryIndexBlock: params.memoryIndexBlock,
    standingMemoryBlock: params.standingMemoryBlock,
    nudge: params.nudge,
    wrapUp: params.wrapUp,
  });
  // Text only — a run NEVER carries native file content. Its files arrive
  // through `attachRunFiles` and are reached with `extract` / `read` /
  // `vision`, which is what the playbook names and what the executor does.
  // Attaching them as file parts (tried 2026-07-27, measured 07-28) put ~61k
  // tokens of parsed PDF on EVERY step — 1.34M of a 2.66M-token run, half its
  // input — for content the executor never answered from: it called `extract`
  // on the same files, then `read` to verify. `<file_attachments>` still names
  // them, so nothing is hidden.
  const parts: UIMessage["parts"] = [{ type: "text", text }];
  const row = await saveMessage({
    id: steeringId,
    conversationId: params.conversationId,
    role: "user",
    parts,
    metadata: { workflowTurnIndex: params.turnIndex },
    authorId: params.run.actingUserId,
  });
  return [
    ...params.history,
    {
      id: row?.id ?? steeringId,
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
  noTaskTurns: number;
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
  /** Live odometer: the run total after each model step, mid-turn. */
  emitUsage: (usage: WorkflowRunUsage) => void;
}): Promise<TurnExecution> => {
  const { run, workflow, turnIndex } = params;
  const conversationId = run.conversationId;
  if (conversationId === null) {
    throw new Error(`run ${run.id} has no conversation`);
  }
  const actingUserId = run.actingUserId ?? undefined;
  const traceId = randomUUIDv7();

  // Which model serves this run: the workflow's own pin → the team's flagship
  // pick → the code default. `modelProfileKey` is persisted as a free
  // `z.string().max(64)` (the agent's `manage_workflow` tool can write any
  // string) and used to be handed straight to `resolveChatModelForProfile`,
  // whose `getProfile` THROWS on an unknown key — so a workflow pinned to a
  // profile we later renamed or retired died mid-run instead of degrading.
  // Resolved FIRST because the between-turn compaction below is budgeted
  // against the profile that will actually serve the turn.
  const {
    profileKey: servingProfileKey,
    fellBack,
    storedReasoningLevel,
  } = await resolveTeamFlagship(workflow.teamId, workflow.modelProfileKey);
  if (fellBack) {
    console.warn(
      `${logPrefix} workflow ${workflow.id} pins unknown/unselectable model "${workflow.modelProfileKey ?? ""}" — falling back to ${servingProfileKey}`,
    );
  }
  // Same resolved key as `agentSet` below, so the profile driving
  // `prepareModelMessages` can never diverge from the one actually serving.
  const modelProfile = resolveChatModelForProfile(servingProfileKey).profile;

  // ---- Context assembly (fragments shared with the chatbot) ----
  // Compact BETWEEN turns — the boundary the context ceiling creates, and the
  // only place a run may edit its own history (nothing signed survives a turn,
  // so no provider's prefix check can reject it). Microcompaction alone, which
  // is what ran here until 2026-09-17, returned 13% on the incident run's 200K:
  // it replaces stale tool results and leaves the loop's replayed reasoning and
  // its own narration, which were 41% of that turn's input.
  //
  // The threshold is capped at the SAME absolute ceiling the turn is cut at.
  // Derived from the window alone it lands near 960K on a 1M-context model —
  // five times what the incident run ever reached, so it never fired once in
  // 42 minutes. In-memory only: persisted messages stay intact.
  //
  // It therefore re-summarises on every turn, and that is affordable HERE and
  // nowhere else. `WORKFLOW_HISTORY_LIMIT` bounds the input to 40 messages, so
  // the cost is flat in the length of the run rather than quadratic; and a
  // ~15-second summary between two multi-minute turns has nobody waiting on
  // it. A chat turn does — see `CHATBOT_COMPACTION_CAP` for what that changes.
  const agentWindow = await loadAgentWindow(
    conversationId,
    WORKFLOW_HISTORY_LIMIT,
  );
  // Captured rather than awaited: the artefact is persisted after the turn
  // commits. The turn that crossed the threshold already holds its context, so
  // making it wait on a write buys it nothing — the NEXT turn is the one that
  // starts small.
  let compactionArtifact: CompactionArtifact | null = null;
  const historyRaw = await compactConversation(agentWindow.messages, {
    profile: modelProfile,
    teamId: run.teamId,
    // One prefix below the ceiling, never equal to it: the ceiling counts the
    // request and this counts the history. See `compactionCapForCeiling`.
    maxThresholdTokens: compactionCapForCeiling(undefined, "workflow"),
    // Same reason as the chat path: a run re-summarises on every turn, so this
    // is the one place where the summariser's share of a run's bill is a
    // question somebody will actually ask.
    traceSessionId: conversationId,
    onCompacted: (artifact) => {
      compactionArtifact = artifact;
    },
  });
  const isFirstTurn = turnIndex === 1;
  const nudge = previousCounter(run, "noProgressTurns") > 0;

  // Harness-owned cursor stamp: the current task flips to `in_progress`
  // BEFORE the model runs — the timeline's "started" edge never depends on
  // the model. Refresh the run's task snapshot with the stamped state.
  const startedTask = await startCurrentTask({ runId: run.id });
  const taskStates = run.taskStates.map((t) =>
    startedTask !== null && t.key === startedTask.key ? startedTask : t,
  );
  const runForPrompt: WorkflowRun = { ...run, taskStates };
  params.emitTaskUpdate(taskStates);

  const [
    fragments,
    externalApps,
    activeMemoryBlock,
    attachedFilesBlock,
    toolPolicies,
  ] = await Promise.all([
    assembleContextFragments(
      {
        organizationId: run.organizationId,
        teamId: run.teamId,
        userId: actingUserId,
        logPrefix,
      },
      // The memory surfaces ride turn 1's steering message and then replay
      // from history. On turns >= 2 they were read anyway and discarded —
      // two queries per turn of every run, for output nothing consumed.
      { mode: STANDING_MODE, memory: isFirstTurn },
    ),
    loadExternalApps({
      conversationId,
      organizationId: run.organizationId,
      teamId: run.teamId,
      userId: actingUserId,
      logPrefix,
    }),
    // Memory recall on the FIRST turn only. It rides in turn 1's steering
    // message (NOT the system prompt, which is byte-stable per run) and then
    // persists via the replayed message history — later turns re-render from
    // the same inputs would re-pay the judge for nothing. What it matches on
    // lives in `recallForWorkflowTurnOne`, with its own eval case.
    isFirstTurn
      ? recallForWorkflowTurnOne({
          organizationId: run.organizationId,
          teamId: run.teamId,
          conversationId,
          actingUserId,
          workflowName: workflow.name,
          playbookGoal: workflow.playbook.goal,
          triggerPayload: run.triggerPayload,
        })
      : Promise.resolve(undefined),
    // Files handed to the run (form/email trigger uploads) → `<file_attachments>`.
    buildConversationAttachedFilesBlock(conversationId),
    getTeamToolPolicies(run.teamId),
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
    activeMemoryBlock,
    // Both are already `undefined` on turns >= 2 — `memory: isFirstTurn`
    // above skips the reads entirely — but say so here too: this is the line
    // a reader checks to know what a later turn's steering message carries.
    memoryIndexBlock: isFirstTurn ? fragments.memoryIndexBlock : undefined,
    // Same fallback rule as a chat turn, minus the placeholder: the steering
    // message has no static scaffold to contradict, so a superseded block is
    // simply absent rather than announced.
    standingMemoryBlock:
      isFirstTurn && (activeMemoryBlock ?? "").trim().length === 0
        ? fragments.standingMemoryBlock
        : undefined,
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
    teamCollectionsBlock: fragments.teamCollectionsBlock,
    enabledSkillsBlock: fragments.enabledSkillsBlock,
    externalAppConnections: externalApps.externalAppConnections,
    externalAppsBlock: externalApps.externalAppsBlock,
    toolPolicies,
    ...(attachedFilesBlock ? { attachedFilesBlock } : {}),
  };

  // ---- Stop plumbing (the user's Stop button → cancel-run publishes) ----
  const abortController = new AbortController();
  const { release: releaseAbortSubscriber } = await subscribeAbort(
    workflowAbortChannel(run.id),
    () => {
      console.info(`${logPrefix} stop signal received run=${run.id}`);
      abortController.abort();
    },
  );

  // ---- Live transcript wire ----
  // Same mechanics as the chat: the turn's UI chunks are pumped into a
  // Redis turn-log keyed by a fresh stream id, and the conversation row
  // points at it so the transcript SSE endpoint can find the live log.
  // Force-set (not CAS): turn serialization is guaranteed upstream, and a
  // stale id from a crashed process must not silence the transcript.
  const streamId = randomUUIDv7();
  await forceSetConversationActiveStream(conversationId, streamId);
  await openTurnLog(streamId);
  let turnLogEnded = false;

  const agentSet = getWorkflowAgentSet(servingProfileKey);

  let turnUsage: LanguageModelUsage | undefined;
  let finalMessages: UIMessage[] = [];
  let toolCallCount = 0;

  // ---- Mid-turn token-budget enforcement, odometer and warning ----
  // `stopWhen` can't read the per-run budget (it gets only `{ steps }`, and the
  // agent is a singleton), so enforce via abort in `onStepEnd`: accumulate
  // per-step usage and stop the turn the moment the run total crosses the
  // ceiling — not only at the turn boundary. Some providers under-report
  // per-step `totalTokens` (MiniMax); the end-of-turn check below is the
  // authoritative fallback for those.
  //
  // This callback is also the ONLY place that knows what a run has spent while
  // it is spending it. `workflow_runs.usage` is written at turn boundaries, so
  // through the 40-minute turn of 2026-09-17 every counter on the run page read
  // the same figure it had read at minute zero, and the first signal of trouble
  // was the run dying. Now each step publishes the running total, and crossing
  // 80% of the budget says so once, in the logs, while the run can still be
  // stopped by hand.
  const tokenBudget =
    workflow.limits.maxTotalTokens ?? WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS;
  const turnAccum: WorkflowRunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    turns: turnIndex,
  };
  let budgetAborted = false;
  let budgetWarned = false;
  const onWorkflowStepEnd = (step: {
    toolCalls: readonly unknown[];
    usage?: LanguageModelUsage;
  }): void => {
    toolCallCount += step.toolCalls.length;
    turnAccum.inputTokens += step.usage?.inputTokens ?? 0;
    turnAccum.outputTokens += step.usage?.outputTokens ?? 0;
    turnAccum.totalTokens += step.usage?.totalTokens ?? 0;
    turnAccum.cachedInputTokens +=
      step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    const spent = run.usage.totalTokens + turnAccum.totalTokens;
    params.emitUsage({
      inputTokens: run.usage.inputTokens + turnAccum.inputTokens,
      outputTokens: run.usage.outputTokens + turnAccum.outputTokens,
      totalTokens: spent,
      cachedInputTokens:
        run.usage.cachedInputTokens + turnAccum.cachedInputTokens,
      turns: turnIndex,
    });
    if (!budgetWarned && spent > tokenBudget * BUDGET_WARN_FRACTION) {
      budgetWarned = true;
      console.warn(
        `${logPrefix} run=${run.id} at ${Math.round((spent / tokenBudget) * 100).toString()}% of its token budget (${spent.toString()}/${tokenBudget.toString()}) turn=${turnIndex.toString()}`,
      );
    }
    if (!budgetAborted && spent > tokenBudget) {
      budgetAborted = true;
      console.warn(`${logPrefix} token budget exceeded mid-turn run=${run.id}`);
      abortController.abort();
    }
  };

  // No `nativeIngestion` here, deliberately: a run's history carries no file
  // parts, so the plan would be empty and `{{nativeMediaNote}}` renders
  // nothing — which is exactly true. The chat still sets it.

  // Thinking depth for this run: the workflow's own setting → the team's stored
  // default (only when this run uses the team's flagship — see
  // `resolveTeamFlagship`) → the profile default. Persisted rather than asked
  // per run, because cron / form / event runs start with nobody there to pick.
  const runReasoningLevel = effectiveReasoningLevel(
    modelProfile,
    workflow.reasoningLevel ?? storedReasoningLevel,
  );

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

    // Two independent per-call provider overrides, merged into one
    // `openrouter` block (a second `providerOptions` key would clobber the
    // first). With neither in play we send no `providerOptions` at all, so an
    // ordinary run stays byte-identical to before.
    //  - C5v2: pin the raw PDF past OpenRouter's default Mistral-OCR pass when
    //    a native file rides this turn.
    //  - the resolved thinking depth, which overrides the profile-baked default
    //    the model instance was constructed with.
    const openrouterOptions = {
      ...(hasNativeFileParts(history, modelProfile)
        ? { plugins: NATIVE_FILE_PARSER_PLUGINS }
        : {}),
      ...(runReasoningLevel !== undefined
        ? {
            reasoning: reasoningParamForProfile(
              modelProfile,
              runReasoningLevel,
            ),
          }
        : {}),
    };
    const providerOptionsSpread =
      Object.keys(openrouterOptions).length > 0
        ? { providerOptions: { openrouter: openrouterOptions } }
        : {};

    const streamOutcome = await streamWithRetryThenFallback({
      primary: () =>
        agentSet.primary.stream({
          messages: modelMessages,
          options: callOptions,
          abortSignal: abortController.signal,
          onStepEnd: onWorkflowStepEnd,
          ...providerOptionsSpread,
        }),
      fallback: () =>
        agentSet.fallback.stream({
          messages: modelMessages,
          options: callOptions,
          abortSignal: abortController.signal,
          onStepEnd: onWorkflowStepEnd,
          ...providerOptionsSpread,
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
        writer.merge(
          toUIMessageStream<WorkflowTools>({
            stream: result.stream,
            // Telemetry parity with the chatbot: tag each persisted assistant
            // message with the trace id + finish/usage blob so a run's messages
            // carry the same observability the chat UI's do.
            messageMetadata: ({ part }) => {
              if (part.type !== "finish") return undefined;
              return buildTurnMessageMetadata(
                part,
                streamOutcome.servedBy,
                modelProfile.key,
                getActiveTraceId(),
              );
            },
          }),
        );
      },
    });
    // Live timeline mirror: completeTask tool results carry the fresh
    // task snapshot — forward it without waiting for the turn to end.
    // Pass-through tap, pre-scrub, so the pump stays the single consumer.
    const taskUpdateTap = new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform: (value, controller) => {
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
            Array.isArray(output.taskStates)
          ) {
            params.emitTaskUpdate(
              (output as { taskStates: WorkflowTaskState[] }).taskStates,
            );
          }
        }
        controller.enqueue(value);
      },
    });
    // The pump drains the whole stream (it is the ONLY consumer, so the
    // `onFinish` above still fires) and writes each scrubbed chunk to the
    // turn-log; it always terminates the log, success or error.
    await pumpChunksToTurnLog(
      streamId,
      uiStream
        .pipeThrough(taskUpdateTap)
        .pipeThrough(buildSensitiveInputScrubber())
        .pipeThrough(dropNonTerminalErrorFrames()),
    );
    turnLogEnded = true;
    // v7: `result.usage` is the all-steps turn total (v6's `totalUsage`).
    turnUsage = await result.usage;
  } finally {
    await releaseAbortSubscriber();
    // A failure before/inside the pump leaves the log open — close it so
    // viewers get their `[DONE]` instead of stalling until the TTL.
    if (!turnLogEnded) {
      await endTurnLog(streamId, "error").catch(() => undefined);
    }
    // CAS-clear: a replayed/parallel turn that force-set a newer id keeps it.
    await clearConversationActiveStream(conversationId, streamId).catch(
      () => undefined,
    );
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
  const usage = addUsage(
    run.usage,
    turnUsage,
    turnIndex,
    turnAccum.totalTokens,
  );
  const approval = abortController.signal.aborted
    ? null
    : detectPendingApproval(finalMessages);
  const progressed =
    taskStatusFingerprint(freshTasks) !== taskStatusFingerprint(run.taskStates);
  const noProgressTurns =
    progressed || toolCallCount > 0
      ? 0
      : previousCounter(run, "noProgressTurns") + 1;
  // The second axis: activity is not convergence. A turn that called 51 tools
  // and closed no task is the shape the 2026-09-17 runaway had, and the counter
  // above read zero for all of it because tool calls counted as progress.
  const noTaskTurns = progressed ? 0 : previousCounter(run, "noTaskTurns") + 1;
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
  } else if (noTaskTurns >= WORKFLOW_MAX_NO_TASK_TURNS) {
    result = {
      status: "failed",
      turnIndex,
      taskStates: freshTasks,
      usage,
      error: {
        code: "NO_CONVERGENCE",
        message: `Worked for ${noTaskTurns.toString()} consecutive turns without closing a task. Last open task: ${currentWorkflowTask(freshTasks)?.key ?? "unknown"}.`,
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
  let runTransitioned = false;
  await db.transaction(async (tx) => {
    const assistantMessages = filterNewAssistantMessages(
      history,
      finalMessages,
    );
    await saveMessages(
      conversationId,
      assistantMessages.map((m) => ({
        role: "assistant" as const,
        parts: m.parts,
        metadata: narrowMessageMetadata(m),
      })),
      tx,
    );
    await recordTurnResult({
      tx,
      runId: run.id,
      result: { ...result, noProgressTurns, noTaskTurns } as WorkflowTurnResult,
    });
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "canceled"
    ) {
      const { transitioned } = await finalizeRun({
        tx,
        runId: run.id,
        // A completed turn is not automatically a useful one. `isNoOpOutcome`
        // reads the task states the executor closed with: everything skipped
        // means it looked at the trigger input and found nothing of its own to
        // do. Splitting that off here — the only call site that ever writes
        // `succeeded` — keeps the turn protocol and the separately deployed
        // Trigger.dev orchestrator untouched.
        status:
          result.status === "completed"
            ? isNoOpOutcome(freshTasks)
              ? "not_applicable"
              : "succeeded"
            : result.status,
        outputSummary: result.outputSummary ?? null,
        ...(runOutputs !== undefined ? { outputs: runOutputs } : {}),
        error: result.error ?? null,
        usage,
      });
      terminal = true;
      runTransitioned = transitioned;
    }
  });

  // Tell the launching chat AFTER the commit (never inside the tx — a
  // rolled-back finalize must not leave a stray message). Settles the wait
  // record, posts the notice, signals a possible resume; each step carries its
  // own exactly-once guard. Fire-and-forget: it must not fail the turn.
  if (terminal) {
    void onWorkflowRunTerminal({ runId: run.id }).catch((err: unknown) => {
      console.warn(
        `${logPrefix} source-conversation notice failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  // Persist the resume point, unless the run is over — a checkpoint nothing
  // will ever read is a summariser call spent for nobody. A run has no
  // participants (`participantIds: []`), so no cast to freeze.
  if (!terminal && compactionArtifact !== null) {
    const artifact: CompactionArtifact = compactionArtifact;
    void persistCheckpoint({
      conversationId,
      window: agentWindow,
      summary: artifact.summary,
      activatedTools: artifact.activatedTools,
      participantIds: [],
      kind: "llm",
      tokensBefore: artifact.tokensBefore,
      tokensAfter: artifact.tokensAfter,
      keptTailCount: artifact.keptTailCount,
      teamId: run.teamId,
    });
  }

  // Notification email — only from the finalize that actually performed the
  // terminal transition (exactly-once), after the commit, fire-and-forget.
  if (runTransitioned) {
    void sendRunCompletionEmailIfEnabled({ runId: run.id }).catch(
      (err: unknown) => {
        console.warn(
          `${logPrefix} completion email failed:`,
          err instanceof Error ? err.message : err,
        );
      },
    );
  }

  return { result, noProgressTurns, noTaskTurns };
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
        // Terminal runs answer terminally (e.g. canceled mid-loop). The turn
        // protocol is deliberately narrower than the run statuses — the
        // orchestrator only needs "keep going or stop" — so everything that
        // ended without failing reports `completed`.
        if (isTerminalRunStatus(run.status)) {
          await send("result", {
            status:
              run.status === "failed" || run.status === "canceled"
                ? run.status
                : "completed",
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
        // Mid-turn odometer. Best-effort like `task-update`: the authoritative
        // figure is still the one committed with the turn result, and a dropped
        // frame costs a stale gauge, never a wrong total.
        const emitUsage = (usage: WorkflowRunUsage): void => {
          void send("usage", { usage });
        };

        const runTurn = (): Promise<TurnExecution> =>
          executeTurn({
            run,
            workflow,
            turnIndex,
            wrapUp: wrapUp ?? false,
            emitTaskUpdate,
            emitUsage,
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
                const turn = await runTurn();
                // Re-assert the type at the END, as `chatbot-turn` does. A
                // recall `embed` whose own span is absent stamps its cost on
                // whatever span is active — the parent — and retypes it
                // EMBEDDING; only a terminal write puts it back. Carries the
                // turn outcome onto the trace root while it is there.
                updateActiveObservation(
                  {
                    output: turn.result.status,
                    metadata: { status: turn.result.status },
                  },
                  { asType: "agent" },
                );
                return turn;
              },
            ),
          );
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
        const finalized = await finalizeRun({
          runId,
          status: "failed",
          error: { code: "TURN_ERROR", message },
        }).catch((err: unknown) => {
          console.error(
            `${logPrefix} finalize-on-error failed run=${runId}:`,
            err instanceof Error ? err.message : err,
          );
          return { transitioned: false };
        });
        if (finalized.transitioned) {
          void sendRunCompletionEmailIfEnabled({ runId }).catch(
            () => undefined,
          );
        }
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
        // Flush HERE, not on the success path: a turn that throws — a user
        // cancelling the run, above all — never reached the old call site, so
        // the batch died with the request. The 2026-07-28 cancelled run spent
        // 9 minutes and left ZERO observations in Langfuse.
        if (langfuseEnabled) await flushLangfuse();
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
  const { parked } = await setRunWaitToken({
    runId,
    waitTokenId: parsed.data.waitTokenId,
  });
  // Approval email — only from the POST that actually parked the run (a
  // retried callback must not double-send). Fire-and-forget.
  if (parked) {
    void sendRunApprovalEmailIfEnabled({ runId }).catch((err: unknown) => {
      console.warn(
        `${logPrefix} approval email failed run=${runId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
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
  const { transitioned } = await finalizeRun({
    runId,
    status: parsed.data.status,
    error: parsed.data.error ?? null,
  });
  // Tell the launching chat for orchestrator-side terminal closes too
  // (deadline, approval timeout, onFailure) — idempotent with the turn-close
  // path.
  void onWorkflowRunTerminal({ runId }).catch(() => undefined);
  // Notification email (the service itself drops `canceled`) — only from the
  // finalize that performed the transition. Fire-and-forget.
  if (transitioned) {
    void sendRunCompletionEmailIfEnabled({ runId }).catch(() => undefined);
  }
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
