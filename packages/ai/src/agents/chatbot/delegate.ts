import { isStepCount, type PrepareStepFunction } from "ai";
import {
  resolveChatModelForProfile,
  resolveModel,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import { subAgentDeadlineMs } from "../../services/sub-agents/report";
import { createDispatchAgentTool } from "../../tools/dispatch-agent";
import {
  AGENT_STEP_MAX_OUTPUT_TOKENS,
  buildAgentSet,
  buildToolsContext,
  type AgentSet,
} from "../shared/agent-builder";
import { memoizeAgentSets, stopOnPendingApproval } from "../shared/agent-set";
import { parseIntEnv } from "../shared/env";
import { policyHiddenToolNames } from "../shared/policy-tool-gate";
import { buildSubAgentSystemPrompt } from "../shared/prompt-renderer";
import { llmRepairToolCall } from "../shared/repair-tool-call";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { workflowSubAgentHiddenToolNames } from "../shared/workflow-tool-gate";
import {
  buildChatbotRuntimeContextBase,
  ChatbotCallOptionsSchema,
  type ChatbotCallOptions,
} from "./call-options";
import { buildSubAgentTools, type SubAgentTools } from "./tools";

/**
 * The sub-agent behind `dispatchAgent`: one agent definition, built per model.
 *
 * By default it runs on the parent's model — every harness that documents a
 * default does the same (Claude Code, Codex, OpenClaw, Hermes). On
 * `model: "fast"` it runs on the team's `documents` pick, shown as "Fast" in
 * settings: the model a team already chose for volume work, instead of a
 * separate category to configure.
 *
 * There used to be a "primary" set pinned to the code-default `chat` role and
 * a "cheap" set on a `dispatch-cheap` role, and neither was what its name
 * said: "primary" ignored the team's model pick, the conversation's pin and
 * the workflow's, and "cheap" was mapped to the `assistant` function, so a
 * team's assistant pick silently replaced it. Both are gone.
 *
 * A fast model that loops is contained by the same guards as any agent built
 * here: the per-step call cap and the loop guard (`agent-builder.ts`) — the
 * failure the chat role measured on DeepSeek V4 Flash was a generation
 * re-emitting one call hundreds of times, which the cap cuts at the step.
 */

/**
 * Step budget. 40 by default: a sub-agent is dispatched for work that takes
 * many calls (reading a set of documents, cross-checking records, researching
 * the web), and 25 ran out on exactly that work. It is a runaway bound, not a
 * pace — a run that reaches it returns `partial` with what it found, and the
 * context-boundary loop in `sub-agent.ts` keeps a long run's context in check.
 * Tunable via `CHATBOT_SUB_AGENT_MAX_STEPS`.
 */
const parseSubAgentMaxSteps = (): number =>
  parseIntEnv("CHATBOT_SUB_AGENT_MAX_STEPS", {
    fallback: 40,
    min: 1,
    max: 100,
  });

/**
 * Which tools a DELEGATE may not call. Team-policy blocked tools are hidden in
 * every context (chat + workflow); a delegate dispatched INSIDE a workflow run
 * additionally prunes what the run's autonomy withholds, so delegation cannot
 * bypass the run's gate. Shared with the page builder, which is a delegate too.
 */
export const delegateHiddenToolNames = (
  ctx: AgentRuntimeContext,
): Set<string> => {
  const hidden = new Set<string>(policyHiddenToolNames(ctx));
  if (ctx.workflowAutonomy !== undefined) {
    for (const name of workflowSubAgentHiddenToolNames(ctx.workflowAutonomy))
      hidden.add(name);
  }
  return hidden;
};

/**
 * Sub-agent tool gate. Every tool is active on every step — no Progressive
 * Disclosure inside a delegate run — minus whatever the gate above hides.
 *
 * `toolsContext` is LOAD-BEARING and was missing here until 2026-08-15: AI SDK
 * v7 hands a tool its context ONLY through `toolsContext[toolName]`, so without
 * it every tool a sub-agent called threw `Missing AgentRuntimeContext`. Nothing
 * about that failure was visible from outside: the throw came back as
 * INTERNAL_ERROR, the model read a run of them as an outage and returned a
 * fluent, entirely false "the platform is down" report instead of the work
 * (measured on the generalist sub-agent: 6 tool calls, 6 identical errors, one
 * apology). Written out per concrete tool set rather than once over a generic
 * `TTools`, because `InferToolSetContext<TTools>` only reduces to the
 * permissive `{}` at a concrete registry — see `buildToolsContext`.
 */
const subAgentPrepareStep = (
  tools: SubAgentTools,
): PrepareStepFunction<SubAgentTools> => {
  const allNames = Object.keys(tools) as (keyof SubAgentTools)[];
  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const hidden = delegateHiddenToolNames(ctx);
    return {
      activeTools: allNames.filter((name) => !hidden.has(name)),
      toolsContext: buildToolsContext(tools, ctx),
    };
  };
};

export const SUB_AGENT_ID = "chatbot.sub";

const makeSubAgentSet = (
  model: ResolvedModel,
): AgentSet<ChatbotCallOptions, SubAgentTools> =>
  buildAgentSet<ChatbotCallOptions, SubAgentTools>({
    id: SUB_AGENT_ID,
    // Its own lane, keyed on the dispatch's own trace id (`subagent-<id>`):
    // parallel sub-agents do not share one pin, and a provider error here
    // cannot re-pin the parent. See `lib/provider-session.ts`.
    sessionScope: "delegate",
    buildTools: buildSubAgentTools,
    // Static text: one cached prefix for every dispatch of every team. What
    // depends on the team rides the first user message (`delegate-brief.ts`).
    systemPrompt: (ctx) => buildSubAgentSystemPrompt(ctx),
    maxOutputTokens: AGENT_STEP_MAX_OUTPUT_TOKENS,
    model,
    fallbackModel: resolveModel("chat-fallback"),
    stopWhen: [
      isStepCount(parseSubAgentMaxSteps()),
      // Defense in depth. A sub-agent has no tool that opens an approval and
      // `/sandbox/exec` refuses it every one, so this never fires — if it
      // ever does, stopping is right: nothing can answer that approval here.
      stopOnPendingApproval<SubAgentTools>(),
    ],
    // At 80% of the dispatch deadline: past that the hard cut is close enough
    // that another round of reading loses the whole run. A report on what it
    // has beats an unfinished investigation that returns nothing.
    softDeadline: {
      afterMs: Math.round(subAgentDeadlineMs() * 0.8),
      text: "[deadline] You are nearly out of time and will be cut off shortly. Stop investigating: write your report now from what you have, and name what you could not cover.",
    },
    repairToolCall: llmRepairToolCall<SubAgentTools>(),
    prepareStep: subAgentPrepareStep,
    buildRuntimeContextBase: buildChatbotRuntimeContextBase,
    callOptionsSchema: ChatbotCallOptionsSchema,
  });

const memoSubAgentSet = memoizeAgentSets(makeSubAgentSet);

/**
 * The sub-agent set for the model a parent is serving on. BUILT PER CALL and
 * memoised per model, never at import: a module-level `resolveModel` runs
 * before the registry is warmed and never sees an overnight quarantine.
 */
export const getSubAgentSet = (
  profileKey: string,
): AgentSet<ChatbotCallOptions, SubAgentTools> =>
  memoSubAgentSet(resolveChatModelForProfile(profileKey));

/**
 * `dispatchAgent` — built once; the chat agent and the workflow executor
 * register this same instance. It only launches: the run is a queue job
 * (`services/sub-agents/worker.ts`), which resolves its agent through
 * `getSubAgentSet` above on whichever replica picks it up.
 */
export const dispatchAgentTool = createDispatchAgentTool();
