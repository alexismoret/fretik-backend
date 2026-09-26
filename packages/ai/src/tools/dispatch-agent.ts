import { releasePythonContext } from "@fretik/shared/services/e2b/release-python-context";
import type { Agent, GenerateTextResult, ToolSet } from "ai";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot/call-options";
import {
  buildDelegateBrief,
  MAX_PRELOADED_SKILLS,
} from "../agents/chatbot/delegate-brief";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import {
  admitDelegation,
  delegationTurnKey,
  releaseDelegationSlot,
} from "../agents/shared/delegation-slots";
import { parseIntEnv } from "../agents/shared/env";
import {
  createSubAgentExecute,
  type SubAgentRun,
  type SubAgentToolCall,
} from "../agents/shared/sub-agent";
import { boundedText } from "../lib/persisted-output";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";

/**
 * `dispatchAgent` — hand one self-contained piece of work to a sub-agent.
 *
 * The sub-agent runs its own tool loop in a fresh context and returns a short
 * report, so its reading never enters the parent's context; several calls in
 * one step run in parallel. The same pattern as Claude Code's `Agent` tool,
 * OpenClaw's `sessions_spawn` and Hermes' `delegate_task`, with the settings
 * those three converge on: one level deep, read-only, no channel to the user,
 * the parent's own model.
 *
 * What a dispatch is made of, and where each part lives:
 *  - the agent: `agents/chatbot/delegate.ts` — the parent's model, a static
 *    prompt, the read-and-compute tool set (`buildSubAgentTools`);
 *  - its opening message: `agents/chatbot/delegate-brief.ts` — the date, the
 *    team's context, skills, collections and apps, any skill the parent
 *    handed over, then the task;
 *  - its limits: `agents/shared/delegation-slots.ts` (how many per turn, how
 *    many at once), the step budget on the agent, the deadline here;
 *  - what the user sees: a progress snapshot after every call the sub-agent
 *    makes and settles, then the result below.
 *
 * Read-only on purpose: a sub-agent's calls never reach the conversation's
 * stream, so a write it made would be one the user never saw, and an approval
 * it opened would have no card to answer it. The parent writes.
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
const PROGRESS_ACTIVITY_ENTRIES = 6;
const CAPTION_MAX_CHARS = 90;

/**
 * Hang insurance and the bound on a turn held open. A sub-agent that has not
 * finished in 20 minutes is either stuck or doing work that belongs in a
 * workflow; its agent is steered to wrap up at 80% of this (`delegate.ts`).
 */
export const dispatchAgentDeadlineMs = (): number =>
  parseIntEnv("DISPATCH_AGENT_DEADLINE_MS", {
    fallback: 20 * 60 * 1000,
    min: 60 * 1000,
    max: 60 * 60 * 1000,
  });

/**
 * Input schema of the `dispatchAgent` tool. Hoisted to module scope — it
 * closes over nothing in the factory — so the eval harness's
 * `evals/tool-schemas.ts` can validate recorded tool calls without
 * constructing the sub-agent sets the factory requires.
 */
export const dispatchAgentInputSchema = z.object({
  task: z
    .string()
    .min(10)
    .describe(
      "The whole brief, in the user's language: the goal, every fact, id and file path the work needs, and what to hand back. The sub-agent sees nothing of this conversation — what you leave out, it does not know.",
    ),
  description: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "3-6 words the user sees on the sub-agent's card, in their language. Example: 'Analyse des factures de mars'.",
    ),
  skills: z
    .array(z.string().min(1).max(64))
    .max(MAX_PRELOADED_SKILLS)
    .optional()
    .describe(
      "Names from <skills> whose procedure the task follows; their full text is handed over up front.",
    ),
});

type DispatchAgentInput = z.infer<typeof dispatchAgentInputSchema>;

/** One line of the sub-agent's call log, as the user reads it. */
export interface DispatchAgentActivity {
  tool: string;
  caption?: string;
  state: SubAgentToolCall["state"];
}

/**
 * What the card draws while the sub-agent works. `progress` is the
 * discriminator — every preliminary yield carries it and the result never
 * does — so the browser tells "working" from "done" without depending on the
 * SDK's `preliminary` flag surviving a reload.
 */
export interface DispatchAgentProgress {
  progress: {
    /** Tool calls issued so far. */
    step: number;
    /** Epoch ms the dispatch started — the card counts elapsed time from it. */
    startedAt: number;
    activity: DispatchAgentActivity[];
  };
}

/**
 * Why a run did not complete — facts, worded by the parent (and the card).
 *  - `step_budget`: it was still working when its step budget ran out.
 *  - `deadline`: it was still working when its wall clock ran out.
 *  - `output_limit`: its last answer hit the output cap mid-sentence.
 *  - `interrupted`: the model call ended on its own (provider cut, error).
 *  - `empty`: it finished without writing a report.
 */
export type DispatchAgentStopReason =
  "step_budget" | "deadline" | "output_limit" | "interrupted" | "empty";

export interface DispatchAgentResult {
  /**
   * `completed` — the report is final. `partial` — the report covers what was
   * done before it stopped (`reason`). `failed` — no report at all.
   */
  status: "completed" | "partial" | "failed";
  summary: string;
  /** Deliverables it wrote under `outputs/`, for the parent to present. */
  files?: string[];
  reason?: DispatchAgentStopReason;
  toolCalls: number;
  durationMs: number;
  /** The last calls it made, for the card's timeline. */
  activity: DispatchAgentActivity[];
}

export type DispatchAgentOutput = DispatchAgentResult | ToolErrorOutput;

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

const activityOf = (
  toolCalls: readonly SubAgentToolCall[],
  entries: number,
): DispatchAgentActivity[] =>
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
const deliverablesOf = (toolCalls: readonly SubAgentToolCall[]): string[] => {
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
): DispatchAgentStopReason | undefined => {
  if (finishReason === "stop") return hasText ? undefined : "empty";
  if (finishReason === "tool-calls") return "step_budget";
  if (finishReason === "length") return "output_limit";
  return "interrupted";
};

/** The report a run ends on, when the run wrote none. */
const missingSummary = (reason: DispatchAgentStopReason, run: SubAgentRun) =>
  `The sub-agent stopped (${reason}) after ${run.toolCalls.length.toString()} tool calls without writing a report. Its last steps are in \`activity\`; do the rest yourself or re-dispatch a narrower task.`;

/**
 * Build the `dispatchAgent` tool against the sub-agent sets. Called once from
 * `agents/chatbot/delegate.ts`, which owns the agents; the chatbot and the
 * workflow executor then register the same instance.
 */
export const createDispatchAgentTool = <TTools extends ToolSet>(deps: {
  /**
   * The sub-agent pair for the model the PARENT is serving on, resolved per
   * call — a quarantine written overnight applies to the first delegation of
   * the day, and a team that picked another model delegates on that model.
   */
  resolve: (profileKey: string) => {
    primary: Agent<ChatbotCallOptions, TTools>;
    fallback: Agent<ChatbotCallOptions, TTools>;
    contextCeiling: number;
  };
}) => {
  const formatResult = (
    result: GenerateTextResult<TTools, Record<string, unknown>, never>,
    _salvaged?: never,
    _usage?: unknown,
    run?: SubAgentRun,
  ): DispatchAgentResult => {
    const done: SubAgentRun = run ?? { durationMs: 0, toolCalls: [] };
    const text = boundedText(result.text.trim(), SUMMARY_BUDGET_CHARS);
    const reason = stopReasonOf(result.finishReason, text.length > 0);
    const files = deliverablesOf(done.toolCalls);
    return {
      status:
        reason === undefined
          ? "completed"
          : text.length > 0
            ? "partial"
            : "failed",
      summary: text.length > 0 ? text : missingSummary(reason ?? "empty", done),
      ...(files.length > 0 ? { files } : {}),
      ...(reason === undefined ? {} : { reason }),
      toolCalls: done.toolCalls.length,
      durationMs: done.durationMs,
      activity: activityOf(done.toolCalls, RESULT_ACTIVITY_ENTRIES),
    };
  };

  const onDeadline = (
    _input: DispatchAgentInput,
    run: SubAgentRun,
  ): DispatchAgentResult => {
    const files = deliverablesOf(run.toolCalls);
    return {
      status: run.toolCalls.length > 0 ? "partial" : "failed",
      summary: missingSummary("deadline", run),
      ...(files.length > 0 ? { files } : {}),
      reason: "deadline",
      toolCalls: run.toolCalls.length,
      durationMs: run.durationMs,
      activity: activityOf(run.toolCalls, RESULT_ACTIVITY_ENTRIES),
    };
  };

  const execute = createSubAgentExecute<
    ChatbotCallOptions,
    TTools,
    DispatchAgentInput,
    DispatchAgentOutput,
    DispatchAgentProgress
  >({
    subAgent: (ctx) => deps.resolve(ctx.modelProfile.key).primary,
    fallbackSubAgent: (ctx) => deps.resolve(ctx.modelProfile.key).fallback,
    contextCeiling: (ctx) => deps.resolve(ctx.modelProfile.key).contextCeiling,
    // Nothing a sub-agent can call changes the team's data — its writes are
    // files in the sandbox, which a retry overwrites rather than duplicates.
    // So an empty run is always worth the one retry the helper allows.
    hasSideEffect: () => false,
    admit: async (_input, ctx) => {
      const verdict = await admitDelegation(delegationTurnKey(ctx));
      if (verdict.admitted) return null;
      return toolError(
        TOOL_ERROR_CODES.DELEGATION_LIMIT,
        `This turn already dispatched ${verdict.limit.toString()} sub-agents, the most one turn may — nothing was started.`,
        "Do the remaining work yourself with your own tools.",
      );
    },
    settle: async (_input, ctx, toolCallId) => {
      releaseDelegationSlot(delegationTurnKey(ctx));
      // Its kernel holds whatever it loaded. Released in the background: the
      // parent has its answer and nothing waits on the cleanup.
      if (ctx.conversationId !== undefined) {
        void releasePythonContext(ctx.conversationId, toolCallId).catch(
          (err: unknown) => {
            console.warn(
              "[dispatchAgent] kernel release failed:",
              err instanceof Error ? err.message : err,
            );
          },
        );
      }
    },
    buildMessages: async ({ task, skills }, ctx) => [
      {
        role: "user",
        content: await buildDelegateBrief({ task, skills }, ctx),
      },
    ],
    buildCallOptions: (_input, ctx, { toolCallId }) => ({
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      conversationId: ctx.conversationId,
      timeZone: ctx.timeZone,
      // Its own trace id, hence its own OpenRouter lane (`provider-session.ts`):
      // parallel sub-agents of one turn no longer share one pin. The turn root
      // stays the prefix, so the cost ledger still folds it into the turn.
      traceId: ctx.traceId ? `${ctx.traceId}.sub.${toolCallId}` : undefined,
      delegateRunId: toolCallId,
      // Everything that decides what it may do, inherited verbatim: a team's
      // `blocked` tool stays blocked, a run's autonomy stays its autonomy.
      toolPolicies: ctx.toolPolicies,
      workflowAutonomy: ctx.workflowAutonomy,
      reasoningLevel: ctx.reasoningLevel,
      // Which connected apps it may reach from the sandbox (egress + skills).
      externalAppConnections: ctx.externalAppConnections,
    }),
    formatResult,
    deadlineMs: dispatchAgentDeadlineMs(),
    onDeadline,
    progress: ({ step, startedAt, toolCalls }) => ({
      progress: {
        step,
        startedAt,
        activity: activityOf(toolCalls, PROGRESS_ACTIVITY_ENTRIES),
      },
    }),
  });

  return buildChatbotTool({
    category: "core",
    searchHint:
      "delegate sub-agent parallel research analyse compare documents records web isolated context",
    // Not read-only: it runs a whole agent, sandbox files included. And its
    // report is the parent's only copy of that work, so it is never compacted.
    isReadOnly: false,
    description: [
      "Hand one self-contained piece of work to a sub-agent: it runs its own tool loop in a fresh context and returns a short report, so its reading never enters your context. Calls made in the same step run in parallel.",
      "It is for work whose raw output you will not quote — see `<delegation>` for when. The same processing over many files is one `python` call, not a sub-agent per file.",
      "The sub-agent has your read tools (knowledge, SQL, records, Drive, web, files, `extract`, `vision`) and `python`/`bash` on the shared `/workspace`; it knows the date and the team's context, skills, collections and apps — nothing of this conversation. It cannot change the team's data or apps, ask the user anything, or show files: it names those steps in its report for you to do.",
      "Result: `{ status, summary, files?, reason? }`. `completed` — build on the summary. `partial` — it stopped early (`reason`); use what it found, then finish yourself or dispatch a narrower task. `failed` — do the work yourself. `files` are deliverables it wrote; show them with `presentFiles`.",
    ].join("\n"),
    inputSchema: dispatchAgentInputSchema,
    execute,
  });
};
