import {
  WORKFLOW_RUN_TASK_ID,
  WorkflowRunTaskPayloadSchema,
  WorkflowTurnResultSchema,
  type WorkflowTurnResult,
} from "@fretik/shared/schemas/workflows";
import { logger, metadata, queue, schemaTask, wait } from "@trigger.dev/sdk";

/**
 * The workflow orchestrator — a THIN durable turn-driver. All intelligence
 * (agent loop, tools, persistence) lives in the AI service behind
 * `POST {FRETIK_AI_URL}/internal/trigger/runs/:runId/turn`; this task only
 * loops bounded turns, mirrors progress into run metadata (what the
 * frontend subscribes to via Trigger Realtime), and enforces the wall-clock
 * budget.
 *
 * ONE RUN, SEVERAL ORCHESTRATORS. This task does not span a human wait. On
 * `needs_approval` it writes the resume point to the run row and EXITS;
 * answering the approval starts a new one at that point. The reason is a
 * platform fact, not a preference: self-hosted Trigger.dev has no
 * checkpoints (Cloud-only — `self-hosting/overview.mdx`), so a `wait.*`
 * here stays EXECUTING and holds its per-workflow concurrency slot for as
 * long as the human takes. Nothing durable may therefore live in this
 * process — anything the next orchestrator needs travels through the DB or
 * the task payload.
 *
 * It deliberately NEVER touches the database (private in prod) and imports
 * nothing but the shared zod protocol schemas — running the AI SDK loop
 * in-task (the pattern in Trigger's vercel-ai-sdk guides) would require
 * exposing Postgres/Redis/E2B publicly, which is the one thing this
 * topology exists to avoid.
 *
 * Turn retries are safe by contract: the AI service anchors idempotency in
 * the run row (`lastTurnIndex`/`lastTurnResult`), so a replayed turnIndex
 * returns the recorded verdict without re-running the model.
 */

/**
 * A turn has NO fixed time cap of its own — hard work (long sandbox runs,
 * slow generations) is legitimate and only bounded by the RUN's wall-clock
 * budget, so each turn's hard timeout is "time left until the deadline".
 * The liveness guard is the heartbeat-gap watchdog: the AI service beats
 * every 10 s even mid-tool-call, so a 45 s gap means the connection died —
 * abort and retry the (idempotent) turn.
 */
const HEARTBEAT_GAP_MS = 45_000;
const TURN_RETRIES = 2;
const TURN_RETRY_BACKOFF_MS = [5_000, 15_000] as const;
const WRAP_UP_BEFORE_DEADLINE_MS = 5 * 60_000;
/** Floor so a turn started seconds before the deadline still gets a chance
 * to wrap up instead of aborting instantly. */
const MIN_TURN_TIMEOUT_MS = 60_000;

const env = (name: "FRETIK_AI_URL" | "TRIGGER_CALLBACK_KEY"): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set on this Trigger.dev environment`);
  }
  return value;
};

const triggerHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Trigger-Key": env("TRIGGER_CALLBACK_KEY"),
});

/** Fire-and-check JSON POST to the AI service (park / finalize). */
const postJson = async (path: string, body: unknown): Promise<void> => {
  const response = await fetch(`${env("FRETIK_AI_URL")}${path}`, {
    method: "POST",
    headers: triggerHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} → ${response.status.toString()}`);
  }
};

class TurnHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Execute one turn against the AI service and return its terminal `result`
 * SSE event. `task-update` and `usage` events are mirrored into run metadata
 * live so the browser's Realtime subscription sees the timeline move — and the
 * token counter climb — mid-turn.
 */
const callTurn = async (params: {
  runId: string;
  turnIndex: number;
  wrapUp: boolean;
  hardTimeoutMs: number;
}): Promise<WorkflowTurnResult> => {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => {
    controller.abort();
  }, params.hardTimeoutMs);
  let lastEventAt = Date.now();
  const gapWatchdog = setInterval(() => {
    if (Date.now() - lastEventAt > HEARTBEAT_GAP_MS) controller.abort();
  }, 5_000);

  try {
    const response = await fetch(
      `${env("FRETIK_AI_URL")}/internal/trigger/runs/${params.runId}/turn`,
      {
        method: "POST",
        headers: { ...triggerHeaders(), Accept: "text/event-stream" },
        body: JSON.stringify({
          turnIndex: params.turnIndex,
          wrapUp: params.wrapUp,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok || response.body === null) {
      throw new TurnHttpError(
        response.status,
        `turn ${params.turnIndex.toString()} → HTTP ${response.status.toString()}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastEventAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      for (;;) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd === -1) break;
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        let event = "";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "task-update" && data.length > 0) {
          try {
            const frame = WorkflowTurnResultSchema.pick({
              taskStates: true,
            }).parse(JSON.parse(data));
            metadata.set("taskStates", frame.taskStates);
          } catch {
            // ignore malformed frames — the terminal result is authoritative
          }
        }
        // The odometer. `workflow_runs.usage` is only written when a turn
        // ends, so through the 42-minute run of 2026-09-17 every gauge on the
        // run page held the figure it had at minute zero. Same best-effort
        // contract as `task-update`: the committed result stays authoritative.
        if (event === "usage" && data.length > 0) {
          try {
            const frame = WorkflowTurnResultSchema.pick({ usage: true }).parse(
              JSON.parse(data),
            );
            metadata.set("usage", frame.usage);
          } catch {
            // ignore malformed frames
          }
        }
        if (event === "result" && data.length > 0) {
          return WorkflowTurnResultSchema.parse(JSON.parse(data));
        }
      }
    }
    throw new Error(
      `turn ${params.turnIndex.toString()} stream ended without a result event`,
    );
  } finally {
    clearTimeout(hardTimeout);
    clearInterval(gapWatchdog);
  }
};

/** Turn call with bounded in-task retries — network errors, 5xx, and
 * watchdog aborts retry (the turn is idempotent server-side); 4xx do not. */
const callTurnWithRetry = async (params: {
  runId: string;
  turnIndex: number;
  wrapUp: boolean;
  hardTimeoutMs: number;
}): Promise<WorkflowTurnResult> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TURN_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = TURN_RETRY_BACKOFF_MS[attempt - 1] ?? 15_000;
      logger.warn("turn retry", {
        attempt,
        backoff,
        runId: params.runId,
        turnIndex: params.turnIndex,
      });
      await wait.for({ seconds: backoff / 1000 });
    }
    try {
      return await callTurn(params);
    } catch (error) {
      if (error instanceof TurnHttpError && error.status < 500) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("turn failed after retries");
};

/** Per-workflow parallelism: `concurrencyKey: workflowId` is set at trigger
 * time, so each workflow gets its own COPY of this queue at this limit —
 * runs beyond it wait as `queued`, which is the backpressure for bulk-upload
 * bursts. The SaaS-wide ceiling is the Trigger.dev ENVIRONMENT concurrency
 * limit (dashboard-side), not this value. Env var must be set on the
 * Trigger.dev environment; changing it requires redeploying this package.
 * Kept low: each executing run fans SSE turn requests at the AI service.
 *
 * It bounds EXECUTING runs only. A run parked on a human holds no slot
 * because it holds no orchestrator (see the park in the loop below) — which
 * is the whole point: this limit is sized for the load an active run puts on
 * the AI service, and an unanswered question is not load. Keep it that way;
 * the moment a `wait.*` reappears in the loop, every parked run silently
 * becomes one of these three. */
const workflowRunConcurrency = (): number => {
  const raw = Number.parseInt(
    process.env["WORKFLOW_RUN_CONCURRENCY"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
};

export const workflowRunQueue = queue({
  name: "workflow-runs",
  concurrencyLimit: workflowRunConcurrency(),
});

export const workflowRun = schemaTask({
  id: WORKFLOW_RUN_TASK_ID,
  schema: WorkflowRunTaskPayloadSchema,
  machine: "micro",
  queue: workflowRunQueue,
  // The in-task turn loop + server-side idempotency is the retry unit — a
  // task-level replay would restart from turn 1 for nothing.
  retry: { maxAttempts: 1 },
  run: async (payload) => {
    // The wall-clock budget bounds ACTIVE work only. Time parked on a human
    // is latency, not compute — so the budget is FROZEN across a park: the
    // orchestrator hands over what is left of it (`remainingMs`) and the one
    // that resumes starts its clock from there. Otherwise an approval
    // answered later than the remaining budget would fail the run with
    // TIME_LIMIT the instant it is approved, making a multi-day park
    // pointless.
    let deadlineAt =
      Date.now() + (payload.remainingMs ?? payload.maxDurationMinutes * 60_000);
    // The Fretik run id, so a realtime subscriber can map this Trigger run
    // to its `workflow_runs` row without reading the (skipped) payload.
    metadata.set("runId", payload.runId);
    metadata.set("status", "running");

    let turnIndex = payload.startTurnIndex;
    for (;;) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await postJson(`/internal/trigger/runs/${payload.runId}/finalize`, {
          status: "failed",
          error: {
            code: "TIME_LIMIT",
            message: `Run exceeded its ${payload.maxDurationMinutes.toString()} min wall-clock budget.`,
          },
        });
        metadata.set("status", "failed");
        return { status: "failed", code: "TIME_LIMIT", turns: turnIndex - 1 };
      }

      const result = await callTurnWithRetry({
        runId: payload.runId,
        turnIndex,
        // Recomputed each turn — the deadline moves when a wait extends it.
        wrapUp: Date.now() >= deadlineAt - WRAP_UP_BEFORE_DEADLINE_MS,
        // The run budget is the ONLY per-turn time bound (hard work is
        // legitimate); the heartbeat watchdog covers dead connections.
        hardTimeoutMs: Math.max(remainingMs, MIN_TURN_TIMEOUT_MS),
      });
      metadata
        .set("status", result.status === "continue" ? "running" : result.status)
        .set("taskStates", result.taskStates)
        .set("usage", result.usage);

      switch (result.status) {
        case "continue": {
          turnIndex += 1;
          break;
        }
        case "needs_approval": {
          // END here — do not wait. Self-hosted Trigger.dev has NO
          // checkpoints (Cloud-only: `self-hosting/overview.mdx`), so
          // `wait.forToken` leaves this orchestrator EXECUTING for the whole
          // human wait, holding its per-workflow concurrency slot and its
          // container. Measured on 2026-09-22: three runs parked at a limit
          // of three stopped a live workflow for six days while four more
          // sat `queued` behind them, and the dashboard showed all three
          // EXECUTING. Raising the limit only moves that wall.
          //
          // So the run's durable state goes to the DB and this process
          // exits. `resumeRunFromApproval` starts a fresh orchestrator at
          // `resumeFromTurnIndex` when the human answers, and the 7-day
          // expiry the wait token used to give for free is now enforced by
          // the stall sweeper against `paused_at`.
          await postJson(`/internal/trigger/runs/${payload.runId}/park`, {
            resumeFromTurnIndex: turnIndex + 1,
            remainingMs: Math.max(deadlineAt - Date.now(), 0),
          });
          // The run row is already `needs_approval` (the turn's own
          // transaction wrote it); this only tells the realtime subscribers
          // why the orchestrator is finishing, so the UI does not read the
          // completing Trigger run as a completing workflow run.
          metadata.set("status", "needs_approval");
          return { status: "parked", turns: turnIndex };
        }
        case "completed":
        case "failed":
        case "canceled": {
          // The AI service already finalized the run atomically with the
          // last turn — just report.
          return {
            status: result.status,
            turns: turnIndex,
            usage: result.usage,
          };
        }
      }
    }
  },
  onFailure: async ({ payload, error }) => {
    // Belt-and-suspenders: a crash that escapes the loop must not leave the
    // run spinning forever in the UI (the stall sweeper is the last resort).
    logger.error("workflow-run failed", { error });
    await postJson(`/internal/trigger/runs/${payload.runId}/finalize`, {
      status: "failed",
      error: {
        code: "ORCHESTRATOR_FAILURE",
        message: error instanceof Error ? error.message : "orchestrator error",
      },
    }).catch(() => undefined);
  },
});
