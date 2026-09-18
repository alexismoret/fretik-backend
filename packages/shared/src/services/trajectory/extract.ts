/**
 * The trajectory ledger — what a chat turn or a workflow run ACTUALLY did,
 * read back from what is already persisted, with no model in the loop.
 *
 * Every tool call a turn makes is already in `ai_messages.parts`, with its
 * `toolCallId`, its un-redacted `input` and its `output`. Nothing reads it
 * back: the journal keeps tool NAMES only, the episode distiller reads text
 * parts and explicitly discards "tool mechanics", failed runs are never
 * distilled, and step counts are not persisted at all. So the one corpus that
 * could tell us where a run spends itself is written every day and never
 * opened.
 *
 * This module opens it. It is pure — messages in, numbers out, no database, no
 * LLM — because it has three consumers that must agree on the same reading:
 * production metrics, the derivation of run recipes, and the eval harness
 * (which computes a subset of this today in `ai/evals/tool-efficiency.ts`, but
 * only over the harness's own captured calls, never over a real run).
 *
 * **On the data.** A `TrajectoryStep` carries the call's real `input` and
 * `output`, because deriving a recipe means reading the code a run ran and the
 * schema it discovered. Those are customer business data. Anything that prints
 * — an operator script, a log line, a Langfuse score — prints the COUNTS and
 * the HASHES beside them, never the values. The hashes exist precisely so two
 * runs can be compared without either being read.
 */

import type { UIMessage } from "ai";
import { canonicalHash } from "../approvals/hash";

/** AI SDK v7 names a tool part `tool-<name>`. */
const TOOL_PART_PREFIX = "tool-";

/** Workspace prefix of a skill file — a `read` of one is a skill read. */
export const SKILL_PATH_PREFIX = "skills/";

/**
 * Workspace prefix of a derived run recipe. A trajectory that touches it is
 * the deterministic form of "this run used its recipe" — the ASI acceptance
 * gate, where an artifact counts only when it was both correct AND used.
 */
export const RECIPE_PATH_PREFIX = "recipes/";

/**
 * Tools whose `code` argument is a program the agent wrote. These are the
 * calls a recipe can carry verbatim, and the ones whose consecutive runs may
 * turn out to be fusable.
 */
const SOURCE_TOOLS = new Set(["python", "bash"]);

/** `output-error`: the part itself failed, so there is no `{error, code}`. */
const PART_ERROR_CODE = "TOOL_PART_ERROR";

/**
 * One tool call, in dispatch order.
 *
 * `input` and `output` are the values as the model sent and received them.
 * `inputHash` / `outputHash` are canonical sha256 over the same values, and
 * are what may be printed, compared and stored.
 */
export interface TrajectoryStep {
  /** Position in the whole trajectory, dispatch order, 0-based. */
  index: number;
  /** Index of the message the call lives in — the way back to the transcript. */
  messageIndex: number;
  toolName: string;
  toolCallId: string;
  /** The call's arguments. Business data: count it, hash it, never print it. */
  input: unknown;
  /** Canonical sha256 of `input` — call identity, safe to print. */
  inputHash: string;
  /** The call's result. Business data, same rule as `input`. */
  output: unknown;
  /** Canonical sha256 of `output`. */
  outputHash: string;
  /** Serialized size of `output` — the proxy for what the call cost in context. */
  outputChars: number;
  /**
   * Set when the call failed: the `code` of the canonical `{ error, code }`
   * envelope, or `TOOL_PART_ERROR` when the part itself is `output-error`.
   */
  errorCode?: string;
  /** For `python` / `bash`: the source, verbatim. */
  source?: string;
  /** For `read`: the workspace-relative path asked for. */
  filePath?: string;
  /** The playbook task open when the call was dispatched (workflow runs only). */
  taskKey?: string;
}

export interface ExtractOptions {
  /**
   * The run's first playbook task. Optional: without it, the calls made before
   * the first `completeTask` are attributed retroactively to whichever task
   * that call reports closing — which is the same answer, derived rather than
   * supplied. A chat turn passes nothing and gets no task keys at all.
   */
  initialTaskKey?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The canonical failure envelope every tool returns (`tool-error-codes.ts`). */
const errorCodeOf = (output: unknown): string | undefined => {
  if (!isRecord(output)) return undefined;
  if (!("error" in output) || !("code" in output)) return undefined;
  return typeof output.code === "string" ? output.code : PART_ERROR_CODE;
};

const stringField = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

/**
 * What a `completeTask` result says about the task cursor.
 *
 * `completeTask` takes no task key — it always closes whichever task is open —
 * but its RESULT names both the task it closed and the one it opened. Reading
 * the cursor from the result rather than replaying the playbook means the
 * attribution reflects what the run did, including the turns where a task was
 * skipped or failed.
 */
const taskTransition = (
  output: unknown,
): { closed?: string; next?: string } | undefined => {
  if (!isRecord(output)) return undefined;
  const closed = stringField(output.closedTask, "key");
  const next = stringField(output.nextTask, "key");
  if (closed === undefined && next === undefined) {
    // `{ allTasksDone: true }` with nothing closed: no task was open.
    return output.allTasksDone === true ? {} : undefined;
  }
  return {
    ...(closed !== undefined ? { closed } : {}),
    ...(next !== undefined ? { next } : {}),
  };
};

interface RawCall {
  messageIndex: number;
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  /** True for a part in `output-error`: the call never returned a result. */
  partErrored: boolean;
}

/**
 * Walk the message tree once, in encounter order, and collect the tool calls.
 *
 * Encounter order IS dispatch order: the parts of one assistant message are
 * appended as the steps of a turn resolve, and messages are loaded ordered.
 * Persisted parts carry no timestamp of their own, so there is nothing else to
 * sort by — and nothing else is needed.
 *
 * Everything here is defensive because `parts` is jsonb: a row written by an
 * older shape of the code is data, not a type.
 */
const collectCalls = (messages: readonly UIMessage[]): RawCall[] => {
  const calls: RawCall[] = [];
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m];
    if (message === undefined) continue;
    const parts: unknown = message.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (typeof type !== "string" || !type.startsWith(TOOL_PART_PREFIX)) {
        continue;
      }
      const state = typeof part.state === "string" ? part.state : "";
      // Only finished calls: an `input-streaming` or `input-available` part is
      // a call that never came back, and counting it as work done would make a
      // crashed turn look busier than a finished one.
      if (state !== "output-available" && state !== "output-error") continue;
      calls.push({
        messageIndex: m,
        toolName: type.slice(TOOL_PART_PREFIX.length),
        toolCallId:
          typeof part.toolCallId === "string"
            ? part.toolCallId
            : `unknown-${m.toString()}-${calls.length.toString()}`,
        input: "input" in part ? part.input : undefined,
        output: "output" in part ? part.output : undefined,
        partErrored: state === "output-error",
      });
    }
  }
  return calls;
};

/** Serialized size of a value, and 0 for whatever will not serialize. */
const serializedChars = (value: unknown): number => {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

/**
 * The ledger: every finished tool call of a conversation, in order, with its
 * identity keys and its task attribution.
 */
export const extractTrajectory = (
  messages: readonly UIMessage[],
  options: ExtractOptions = {},
): TrajectoryStep[] => {
  const calls = collectCalls(messages);
  const steps: TrajectoryStep[] = [];
  let currentTask = options.initialTaskKey;
  /** Steps still unattributed, waiting for the first `completeTask` to name them. */
  let unattributed: number[] = [];

  calls.forEach((call, index) => {
    const source = SOURCE_TOOLS.has(call.toolName)
      ? stringField(call.input, "code")
      : undefined;
    const filePath =
      call.toolName === "read"
        ? stringField(call.input, "file_path")
        : undefined;
    const errorCode = call.partErrored
      ? PART_ERROR_CODE
      : errorCodeOf(call.output);

    const step: TrajectoryStep = {
      index,
      messageIndex: call.messageIndex,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      inputHash: canonicalHash(call.input ?? null),
      output: call.output,
      outputHash: canonicalHash(call.output ?? null),
      outputChars: serializedChars(call.output),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(currentTask !== undefined ? { taskKey: currentTask } : {}),
    };
    steps.push(step);
    if (currentTask === undefined) unattributed.push(index);

    if (call.toolName !== "completeTask") return;
    const transition = taskTransition(call.output);
    if (transition === undefined) return;
    // The closing call belongs to the task it closed, and so does everything
    // still unattributed before it.
    if (transition.closed !== undefined) {
      step.taskKey = transition.closed;
      for (const i of unattributed) {
        const earlier = steps[i];
        if (earlier !== undefined) earlier.taskKey = transition.closed;
      }
    }
    unattributed = [];
    currentTask = transition.next;
  });

  return steps;
};

/** Per-task rollup, in the order the tasks were worked on. */
export interface TaskRollup {
  taskKey: string;
  calls: number;
  perTool: Record<string, number>;
  errorCalls: number;
  skillReadCalls: number;
  pythonCells: number;
  /** Total source length of this task's `python` cells. */
  pythonChars: number;
  /** Total serialized output this task fed back into the context. */
  outputChars: number;
}

export interface TrajectorySummary {
  totalCalls: number;
  perTool: Record<string, number>;
  /** Calls that came back as a failure — the `{ error, code }` envelope. */
  errorCalls: number;
  /** Failure codes and how often each occurred. */
  perErrorCode: Record<string, number>;
  /** Errored calls followed later by another call to the same tool. */
  errorThenRetry: number;
  /** Surplus repeats of an identical (tool + canonical input) call. */
  redundantCalls: number;
  /** `read` calls under `skills/`, and how many distinct files they fetched. */
  skillReads: { calls: number; distinctFiles: number };
  /** `python` cells: how many, how big, and how many failed then recovered. */
  pythonCells: { count: number; chars: number; recoveredAfterError: number };
  /** Whether the trajectory read or executed a derived recipe file. */
  recipeUsed: boolean;
  /** Total serialized tool output — the context this trajectory paid for. */
  outputChars: number;
  perTask: TaskRollup[];
}

const bump = (counter: Record<string, number>, key: string): void => {
  counter[key] = (counter[key] ?? 0) + 1;
};

const emptyRollup = (taskKey: string): TaskRollup => ({
  taskKey,
  calls: 0,
  perTool: {},
  errorCalls: 0,
  skillReadCalls: 0,
  pythonCells: 0,
  pythonChars: 0,
  outputChars: 0,
});

/** A trajectory step that reads or runs a derived recipe file. */
const touchesRecipe = (step: TrajectoryStep): boolean =>
  step.filePath?.includes(RECIPE_PATH_PREFIX) === true ||
  step.source?.includes(RECIPE_PATH_PREFIX) === true;

/**
 * Roll a trajectory up into the numbers a run is judged on.
 *
 * Counts only. Nothing here reads a value, so the result is safe to log, to
 * persist on the run, and to publish as a Langfuse score.
 */
export const summarizeTrajectory = (
  steps: readonly TrajectoryStep[],
): TrajectorySummary => {
  const perTool: Record<string, number> = {};
  const perErrorCode: Record<string, number> = {};
  const identityCounts = new Map<string, number>();
  const skillFiles = new Set<string>();
  const perTask = new Map<string, TaskRollup>();

  let errorCalls = 0;
  let skillReadCalls = 0;
  let pythonCells = 0;
  let pythonChars = 0;
  let outputChars = 0;
  let recipeUsed = false;

  for (const step of steps) {
    bump(perTool, step.toolName);
    identityCounts.set(
      `${step.toolName} ${step.inputHash}`,
      (identityCounts.get(`${step.toolName} ${step.inputHash}`) ?? 0) + 1,
    );
    outputChars += step.outputChars;
    if (touchesRecipe(step)) recipeUsed = true;

    const rollup =
      step.taskKey === undefined
        ? undefined
        : (perTask.get(step.taskKey) ?? emptyRollup(step.taskKey));
    if (rollup !== undefined && step.taskKey !== undefined) {
      perTask.set(step.taskKey, rollup);
      rollup.calls++;
      bump(rollup.perTool, step.toolName);
      rollup.outputChars += step.outputChars;
    }

    if (step.errorCode !== undefined) {
      errorCalls++;
      bump(perErrorCode, step.errorCode);
      if (rollup !== undefined) rollup.errorCalls++;
    }
    if (step.filePath?.startsWith(SKILL_PATH_PREFIX) === true) {
      skillReadCalls++;
      skillFiles.add(step.filePath);
      if (rollup !== undefined) rollup.skillReadCalls++;
    }
    if (step.toolName === "python") {
      pythonCells++;
      pythonChars += step.source?.length ?? 0;
      if (rollup !== undefined) {
        rollup.pythonCells++;
        rollup.pythonChars += step.source?.length ?? 0;
      }
    }
  }

  let redundantCalls = 0;
  for (const count of identityCounts.values()) {
    if (count > 1) redundantCalls += count - 1;
  }

  // error→retry: an errored call with a LATER call to the same tool. The
  // distance is deliberately unbounded — a run that errors, wanders, and comes
  // back to the same tool ten steps later is the same thrash.
  let errorThenRetry = 0;
  let recoveredAfterError = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined || step.errorCode === undefined) continue;
    const later = steps
      .slice(i + 1)
      .find((next) => next.toolName === step.toolName);
    if (later === undefined) continue;
    errorThenRetry++;
    if (step.toolName === "python" && later.errorCode === undefined) {
      recoveredAfterError++;
    }
  }

  return {
    totalCalls: steps.length,
    perTool,
    errorCalls,
    perErrorCode,
    errorThenRetry,
    redundantCalls,
    skillReads: { calls: skillReadCalls, distinctFiles: skillFiles.size },
    pythonCells: {
      count: pythonCells,
      chars: pythonChars,
      recoveredAfterError,
    },
    recipeUsed,
    outputChars,
    perTask: [...perTask.values()],
  };
};
