import { completeConversationTask } from "@fretik/shared/services/conversation-tasks/complete";
import { listOpenSubAgentTasks } from "@fretik/shared/services/conversation-tasks/list";
import { registerConversationTask } from "@fretik/shared/services/conversation-tasks/register";
import type { ToolExecutionOptions } from "ai";
import { randomUUIDv7 } from "bun";
import { z } from "zod";
import type { ChatbotCallOptions } from "../agents/chatbot/call-options";
import {
  buildDelegateBrief,
  MAX_PRELOADED_SKILLS,
} from "../agents/chatbot/delegate-brief";
import { buildChatbotTool } from "../agents/shared/chatbot-tool";
import {
  claimDispatch,
  delegationTurnKey,
  maxOpenSubAgents,
} from "../agents/shared/delegation-slots";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../agents/shared/runtime-context";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";
import { turnRootOf } from "../lib/turn-usage";
import {
  enqueueSubAgent,
  type SubAgentJobData,
} from "../services/sub-agents/queue";
import { MANAGE_AGENTS_TOOL } from "./manage-agents";

/**
 * `dispatchAgent` — hand one self-contained piece of work to a sub-agent,
 * which works WHILE the parent does.
 *
 * The call answers at once with the sub-agent's id; the run itself is a queue
 * job (`services/sub-agents/`). The parent keeps working, and when it needs
 * the report it either ends its turn — the conversation resumes itself once
 * every sub-agent it launched has finished, through the same wait registry a
 * workflow run launched from the chat uses — or waits for it with
 * `manageAgents`, which also shows where they stand and stops them. The model
 * Claude Code, Codex, OpenClaw and Hermes converge on: launch is asynchronous,
 * waiting is the parent's decision, and a sub-agent never talks to the user.
 * Before, a dispatch held the parent's step until its report came back: the
 * AI SDK runs a step's tool calls together and waits for all of them, so a
 * twenty-minute run held the whole answer — and the user — for twenty
 * minutes, and the parent could do nothing meanwhile.
 *
 * What a dispatch is made of, and where each part lives:
 *  - the agent: `agents/chatbot/delegate.ts` — the parent's model (or the
 *    team's Fast one), a static prompt, the read-and-compute tool set;
 *  - its opening message: `agents/chatbot/delegate-brief.ts` — rendered HERE,
 *    in the process that has the parent's context, and carried by the job;
 *  - its limits: `agents/shared/delegation-slots.ts` (how many per turn, how
 *    many open per conversation), its step budget and deadline;
 *  - its run, report and stop: `services/sub-agents/`;
 *  - what the user sees: the card reads the task row, live.
 *
 * Read-only on purpose: a sub-agent's calls never reach the conversation's
 * stream, so a write it made would be one the user never saw, and an approval
 * it opened would have no card to answer it. The parent writes.
 */

/**
 * Input schema of the `dispatchAgent` tool. Hoisted to module scope — it
 * closes over nothing in the factory — so the eval harness's
 * `evals/tool-schemas.ts` can validate recorded tool calls.
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
  model: z
    .enum(["fast"])
    .optional()
    .describe(
      "`fast` for long but mechanical work — many similar reads, bulk extraction, a checklist over many items: a faster, cheaper model. Omit when the work needs judgement.",
    ),
});

type DispatchAgentInput = z.infer<typeof dispatchAgentInputSchema>;

/**
 * What a dispatch answers. `status` is not a report status on purpose: the
 * model reads `completed` / `partial` / `failed` as an outcome, and there is
 * none yet.
 */
export interface DispatchAgentLaunch {
  status: "started";
  agentId: string;
  next: string;
}

export type DispatchAgentOutput = DispatchAgentLaunch | ToolErrorOutput;

/** The instruction a launch hands back — how to get the report, per surface. */
const nextStep = (inWorkflow: boolean): string =>
  inWorkflow
    ? "Started; it works while you do. Carry on with what does not need its report, then collect it with `manageAgents` `wait`."
    : "Started; it works while you do. Carry on with what does not need its report. When you need it, end your turn: you are resumed with every report once they have all finished. `manageAgents` shows where they stand, waits, or stops them.";

/**
 * The profile a dispatch runs on: the parent's own model, or — for
 * `model: "fast"` — the team's `documents` pick ("Fast" in settings), which
 * the handler resolved for the turn. A context that carries no such pick
 * keeps the parent's model rather than guessing one.
 */
const profileKeyOf = (
  input: DispatchAgentInput,
  ctx: { modelProfile: { key: string }; fastProfileKey?: string },
): string =>
  input.model === "fast" && ctx.fastProfileKey !== undefined
    ? ctx.fastProfileKey
    : ctx.modelProfile.key;

/**
 * The sub-agent's call options — everything its run needs from the parent,
 * as data, since the job may run on another replica.
 */
const callOptionsOf = (
  ctx: AgentRuntimeContext,
  agentId: string,
  profileKey: string,
): ChatbotCallOptions => ({
  teamId: ctx.teamId,
  organizationId: ctx.organizationId,
  userId: ctx.userId,
  userName: ctx.userName,
  conversationId: ctx.conversationId,
  timeZone: ctx.timeZone,
  // Its own trace id: its own OpenRouter lane (`provider-session.ts`) and its
  // own cost ledger key. No dot, so `turnRootOf` keeps it whole instead of
  // folding it into the launching turn, which has usually ended by then.
  traceId: `subagent-${agentId}`,
  delegateRunId: agentId,
  // Everything that decides what it may do, inherited verbatim: a team's
  // `blocked` tool stays blocked, a run's autonomy stays its autonomy.
  toolPolicies: ctx.toolPolicies,
  workflowAutonomy: ctx.workflowAutonomy,
  // A depth chosen against the parent's model; on another profile it could
  // name a rung that model does not have.
  ...(profileKey === ctx.modelProfile.key
    ? { reasoningLevel: ctx.reasoningLevel }
    : {}),
  // Which connected apps it may reach from the sandbox (egress + skills).
  externalAppConnections: ctx.externalAppConnections,
});

const launch = async (
  input: DispatchAgentInput,
  options: ToolExecutionOptions<unknown>,
): Promise<DispatchAgentOutput> => {
  const ctx = getRuntimeContext(options);
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) {
    return toolError(
      TOOL_ERROR_CODES.NO_CONVERSATION,
      "Sub-agents run inside a conversation, and this call has none — nothing was started.",
      "Do the work yourself with your own tools.",
    );
  }

  const verdict = claimDispatch(delegationTurnKey(ctx));
  if (!verdict.admitted) {
    return toolError(
      TOOL_ERROR_CODES.DELEGATION_LIMIT,
      `This turn already dispatched ${verdict.limit.toString()} sub-agents, the most one turn may — nothing was started.`,
      "Do the remaining work yourself with your own tools.",
    );
  }
  // A soft cap: parallel dispatches of one step all read the same count. It
  // exists to stop a runaway, not to meter a careful fan-out.
  const open = (await listOpenSubAgentTasks(conversationId)).filter(
    (task) => task.status === "pending",
  ).length;
  const openLimit = maxOpenSubAgents();
  if (open >= openLimit) {
    return toolError(
      TOOL_ERROR_CODES.DELEGATION_LIMIT,
      `${open.toString()} sub-agents are already running in this conversation, the most it may have at once — nothing was started.`,
      "Wait for them (`manageAgents`) or do this part yourself.",
    );
  }

  // Its own id, not the provider's tool-call id: the task row's ref is unique
  // across every conversation, and a provider that numbers its calls
  // `call_0`, `call_1` would collide the second conversation with the first.
  const agentId = randomUUIDv7();
  const profileKey = profileKeyOf(input, ctx);
  const inWorkflow = ctx.workflowRunId !== undefined;

  // Registered before the job exists, so a turn ending right after this call
  // already sees it pending — and a worker never runs a job with no row.
  await registerConversationTask({
    conversationId,
    kind: "sub_agent",
    ref: agentId,
    title: input.description,
    metadata: {
      subAgent: {
        ...(ctx.userId !== undefined ? { launchedByUserId: ctx.userId } : {}),
        toolCallId: options.toolCallId,
        ...(input.model === "fast" ? { model: "fast" as const } : {}),
        ...(ctx.traceId !== undefined
          ? { turnId: turnRootOf(ctx.traceId) }
          : {}),
      },
    },
  });

  const job: SubAgentJobData = {
    agentId,
    conversationId,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    description: input.description,
    profileKey,
    brief: await buildDelegateBrief(
      { task: input.task, skills: input.skills },
      ctx,
    ),
    callOptions: callOptionsOf(ctx, agentId, profileKey),
    ...(ctx.traceId !== undefined ? { parentTraceId: ctx.traceId } : {}),
  };
  try {
    await enqueueSubAgent(job);
  } catch (err) {
    console.error(`[dispatchAgent] ${agentId} could not be queued:`, err);
    // Settled AND consumed: the turn handles this error inline, so the
    // conversation must not be woken to hear it again.
    await completeConversationTask({
      kind: "sub_agent",
      ref: agentId,
      status: "failed",
      consume: true,
    }).catch(() => undefined);
    return toolError(
      TOOL_ERROR_CODES.INTERNAL_ERROR,
      "The sub-agent could not be started (its queue is unreachable) — nothing is running.",
      "Do the work yourself with your own tools.",
    );
  }

  // `manageAgents` joins the parent's tools from its next step on — through
  // the same activation set `searchTools` writes, which every step reads.
  ctx.dynamicToolManager.activate([MANAGE_AGENTS_TOOL]);
  return { status: "started", agentId, next: nextStep(inWorkflow) };
};

/**
 * Built once; the chat agent and the workflow executor register this same
 * instance.
 */
export const createDispatchAgentTool = () =>
  buildChatbotTool({
    category: "core",
    searchHint:
      "delegate sub-agent parallel research analyse compare documents records web isolated context background",
    // Not read-only: it starts a whole agent, sandbox files included.
    isReadOnly: false,
    description: [
      "Start a sub-agent on one self-contained piece of work. It runs its own tool loop in a fresh context WHILE you keep working, and hands back a short report, so its reading never enters your context. Several calls in one step start several sub-agents.",
      "It is for work whose raw output you will not quote — see `<delegation>` for when. The same processing over many files is one `python` call, not a sub-agent per file.",
      "The sub-agent has your read tools (knowledge, SQL, records, Drive, web, files, `extract`, `vision`) and `python`/`bash` on the shared `/workspace`; it knows the date and the team's context, skills, collections and apps — nothing of this conversation. It cannot change the team's data or apps, ask the user anything, or show files: it names those steps in its report for you to do.",
      'Answers at once with `{ status: "started", agentId }`. The report — `{ status, summary, files?, reason? }` — reaches you through `manageAgents` or when you are resumed.',
    ].join("\n"),
    inputSchema: dispatchAgentInputSchema,
    execute: launch,
  });
