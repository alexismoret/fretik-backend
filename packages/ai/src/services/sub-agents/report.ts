import type { GenerateTextResult, ToolSet } from "ai";
import { parseIntEnv } from "../../agents/shared/env";
import type {
  SubAgentRun,
  SubAgentToolCall,
} from "../../agents/shared/sub-agent";
import { boundedText } from "../../lib/persisted-output";

/**
 * What a sub-agent hands back, and how it is built from the run.
 *
 * The same report whoever reads it: the parent through `manageAgents`, the
 * resumed turn through the continuation message, the chat card through the
 * task row. Facts only — every word the user sees is in the locale files.
 */

/**
 * Cap on the report. A summary is what the parent reads back on every later
 * step of its turn — it does not need the sub-agent's working, and 12 000
 * characters (~3 000 tokens) is several pages of findings.
 */
const SUMMARY_BUDGET_CHARS = 12_000;

/** Entries of the call log carried in the final result, newest last. */
const RESULT_ACTIVITY_ENTRIES = 12;
/** Entries a live snapshot carries — what the card shows while it runs. */
export const PROGRESS_ACTIVITY_ENTRIES = 6;
const CAPTION_MAX_CHARS = 90;

/**
 * Hang insurance. A sub-agent that has not finished in 20 minutes is either
 * stuck or doing work that belongs in a workflow; its agent is steered to wrap
 * up at 80% of this (`agents/chatbot/delegate.ts`).
 */
export const subAgentDeadlineMs = (): number =>
  parseIntEnv("DISPATCH_AGENT_DEADLINE_MS", {
    fallback: 20 * 60 * 1000,
    min: 60 * 1000,
    max: 60 * 60 * 1000,
  });

/** One line of the sub-agent's call log, as the user reads it. */
export interface SubAgentActivity {
  tool: string;
  caption?: string;
  state: SubAgentToolCall["state"];
}

/**
 * Why a run did not complete — facts, worded by the parent (and the card).
 *  - `step_budget`: it was still working when its step budget ran out.
 *  - `deadline`: it was still working when its wall clock ran out.
 *  - `output_limit`: its last answer hit the output cap mid-sentence.
 *  - `interrupted`: the model call ended on its own (provider cut, error).
 *  - `empty`: it finished without writing a report.
 *  - `stopped`: someone asked it to stop (see `SubAgentStopper`).
 */
export type SubAgentStopReason =
  | "step_budget"
  | "deadline"
  | "output_limit"
  | "interrupted"
  | "empty"
  | "stopped";

export interface SubAgentReport {
  /**
   * `completed` — the report is final. `partial` — the report covers what was
   * done before it stopped (`reason`). `failed` — no report at all.
   */
  status: "completed" | "partial" | "failed";
  summary: string;
  /** Deliverables it wrote under `outputs/`, for the parent to present. */
  files?: string[];
  reason?: SubAgentStopReason;
  toolCalls: number;
  durationMs: number;
  /** The last calls it made, for the card's timeline. */
  activity: SubAgentActivity[];
}

const captionOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const caption: unknown = Reflect.get(input, "caption");
  if (typeof caption !== "string") return undefined;
  const trimmed = caption.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > CAPTION_MAX_CHARS
    ? `${trimmed.slice(0, CAPTION_MAX_CHARS - 1)}…`
    : trimmed;
};

export const activityOf = (
  toolCalls: readonly SubAgentToolCall[],
  entries: number = RESULT_ACTIVITY_ENTRIES,
): SubAgentActivity[] =>
  toolCalls.slice(-entries).map((call) => {
    const caption = captionOf(call.input);
    return {
      tool: call.toolName,
      ...(caption === undefined ? {} : { caption }),
      state: call.state,
    };
  });

const WORKSPACE_PREFIX = "/workspace/";

/**
 * Deliverables the run wrote under `outputs/` — what `python`/`bash` report as
 * artifacts and `transform` as its output. Not `outputs/persisted/` (the
 * overflow of oversized tool results) nor `outputs/results/` (the kernel's
 * automatic display captures): neither is a file anyone asked for.
 */
export const deliverablesOf = (
  toolCalls: readonly SubAgentToolCall[],
): string[] => {
  const paths = new Set<string>();
  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const path = raw.startsWith(WORKSPACE_PREFIX)
      ? raw.slice(WORKSPACE_PREFIX.length)
      : raw;
    if (
      path.startsWith("outputs/") &&
      !path.startsWith("outputs/persisted/") &&
      !path.startsWith("outputs/results/")
    ) {
      paths.add(path);
    }
  };
  for (const call of toolCalls) {
    const output = call.output;
    if (call.state !== "done" || typeof output !== "object" || output === null)
      continue;
    const artifacts: unknown = Reflect.get(output, "artifacts");
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        if (typeof artifact === "object" && artifact !== null) {
          add(Reflect.get(artifact, "path"));
        }
      }
    }
    add(Reflect.get(output, "outputPath"));
  }
  return [...paths];
};

const stopReasonOf = (
  finishReason: string,
  hasText: boolean,
): SubAgentStopReason | undefined => {
  if (finishReason === "stop") return hasText ? undefined : "empty";
  if (finishReason === "tool-calls") return "step_budget";
  if (finishReason === "length") return "output_limit";
  return "interrupted";
};

/** The report a run ends on, when the run wrote none. */
const missingSummary = (reason: SubAgentStopReason, run: SubAgentRun) =>
  `The sub-agent stopped (${reason}) after ${run.toolCalls.length.toString()} tool calls without writing a report. Its last steps are in \`activity\`; do the rest yourself or dispatch a narrower task.`;

/** A finished run's report. */
export const reportOfRun = <TOOLS extends ToolSet>(
  result: GenerateTextResult<TOOLS, Record<string, unknown>, never>,
  run: SubAgentRun,
): SubAgentReport => {
  const text = boundedText(result.text.trim(), SUMMARY_BUDGET_CHARS);
  const reason = stopReasonOf(result.finishReason, text.length > 0);
  const files = deliverablesOf(run.toolCalls);
  return {
    status:
      reason === undefined
        ? "completed"
        : text.length > 0
          ? "partial"
          : "failed",
    summary: text.length > 0 ? text : missingSummary(reason ?? "empty", run),
    ...(files.length > 0 ? { files } : {}),
    ...(reason === undefined ? {} : { reason }),
    toolCalls: run.toolCalls.length,
    durationMs: run.durationMs,
    activity: activityOf(run.toolCalls),
  };
};

/** The report of a run its wall clock cut before it could write one. */
export const reportOfDeadline = (run: SubAgentRun): SubAgentReport => {
  const files = deliverablesOf(run.toolCalls);
  return {
    status: run.toolCalls.length > 0 ? "partial" : "failed",
    summary: missingSummary("deadline", run),
    ...(files.length > 0 ? { files } : {}),
    reason: "deadline",
    toolCalls: run.toolCalls.length,
    durationMs: run.durationMs,
    activity: activityOf(run.toolCalls),
  };
};

/**
 * The report of a run someone stopped. It had no chance to write, so it says
 * so, and keeps what is on record: its calls and any file it had written.
 */
export const reportOfStop = (run: SubAgentRun): SubAgentReport => {
  const files = deliverablesOf(run.toolCalls);
  return {
    status: "failed",
    summary: `The sub-agent was stopped after ${run.toolCalls.length.toString()} tool calls, before writing a report.`,
    ...(files.length > 0 ? { files } : {}),
    reason: "stopped",
    toolCalls: run.toolCalls.length,
    durationMs: run.durationMs,
    activity: activityOf(run.toolCalls),
  };
};
