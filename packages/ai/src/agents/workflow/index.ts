import { isStepCount, type PrepareStepFunction } from "ai";
import { z } from "zod";
import {
  resolveChatModelForProfile,
  resolveModel,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import {
  buildChatbotRuntimeContextBase,
  ChatbotCallOptionsSchema,
  dispatchAgentTool,
} from "../chatbot";
import {
  buildAgentSet,
  buildToolsContext,
  type AgentRuntimeContextBase,
  type AgentSet,
} from "../shared/agent-builder";
import { memoizeAgentSets, stopOnPendingApproval } from "../shared/agent-set";
import { parseIntEnv } from "../shared/env";
import { policyHiddenToolNames } from "../shared/policy-tool-gate";
import {
  computeCoreToolNames,
  pickDomainRegistry,
  progressiveActiveTools,
} from "../shared/progressive-disclosure";
import { buildWorkflowSystemPrompt } from "../shared/prompt-renderer";
import { llmRepairToolCall } from "../shared/repair-tool-call";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { workflowMainHiddenToolNames } from "../shared/workflow-tool-gate";
import { buildWorkflowTools, type WorkflowTools } from "./tools";

/**
 * Workflow executor agent — the chatbot's headless sibling. Same
 * `buildAgentSet` machinery, chatbot-parity tools (see `./tools.ts`), the
 * unified prompt's `workflow` variant, and one structural difference: the
 * turn is a CHECKPOINT unit (the Trigger.dev orchestrator loops turns until
 * the playbook is exhausted), so the step budget below is persistence
 * granularity, not an autonomy limit.
 */

/**
 * Steps per turn — a runaway SAFETY VALVE, not a checkpoint granularity. The
 * real turn boundary is a natural pause (an approval/question, or the playbook
 * exhausted); a turn runs uninterrupted until then. Chopping a turn at a low
 * step count forced a full prompt-cache miss at every boundary, so the cap is
 * high. Tunable via `WORKFLOW_TURN_MAX_STEPS` (default 50, range [1, 100]).
 */
const parseWorkflowTurnMaxSteps = (): number =>
  parseIntEnv("WORKFLOW_TURN_MAX_STEPS", { fallback: 50, min: 1, max: 100 });

/**
 * How often (in steps) to re-anchor the model on the playbook mid-turn. With
 * long turns the goal drifts out of recent attention; every K steps a compact
 * generic reminder is appended at the context tail. Kept append-only so the
 * accumulated history stays a byte-identical prefix (prompt cache intact).
 * Tunable via `WORKFLOW_REANCHOR_EVERY_STEPS` (default 10, range [1, 100]).
 */
const parseReanchorEverySteps = (): number =>
  parseIntEnv("WORKFLOW_REANCHOR_EVERY_STEPS", {
    fallback: 10,
    min: 1,
    max: 100,
  });

/**
 * Compact generic re-anchor injected mid-turn. Deliberately NAMES no task —
 * `completeTask` may have advanced the cursor since the turn opened, so a
 * task-specific reminder could be stale. The live cursor is already in the
 * steering message at the head of the turn.
 */
const REANCHOR_TEXT =
  "Re-read the playbook in `<workflow_context>` and stay on the current open task. Call `completeTask` the moment its expected output exists, then continue to the next task in the same turn.";

/**
 * Hard per-step output cap. Bounds a single runaway generation (the incident
 * burned 64,829 output tokens in one step). Safe: truncated pure text ends the
 * loop cleanly and resumes next turn; a truncated tool-call is healed by
 * `llmRepairToolCall`. Tunable via `WORKFLOW_STEP_MAX_OUTPUT_TOKENS`
 * (default 16000, range [1000, 64000]).
 */
const parseWorkflowStepMaxOutputTokens = (): number =>
  parseIntEnv("WORKFLOW_STEP_MAX_OUTPUT_TOKENS", {
    fallback: 16_000,
    min: 1000,
    max: 64_000,
  });

export const WorkflowCallOptionsSchema = ChatbotCallOptionsSchema.extend({
  /** The `workflow_runs` row this turn executes. */
  workflowRunId: z.uuid(),
  /** The run's write-autonomy mode (gates tools + the run_plan path). */
  workflowAutonomy: z.enum(["read_only", "approval_required", "autonomous"]),
  /**
   * Rendered `{{playbookBlock}}` fragment — goal, autonomy, trigger payload,
   * and the task list with live statuses. Built by the turn handler from the
   * run row.
   */
  playbookBlock: z.string(),
  /**
   * Domain-tool names hinted by the playbook (`tasks[].toolHints`), union
   * across tasks. Pre-activated on the DynamicToolManager at call time so
   * hinted tools are live from step 0 — reliability without paying the full
   * catalogue's schemas.
   */
  toolHints: z.array(z.string()).optional(),
});

export type WorkflowCallOptions = z.infer<typeof WorkflowCallOptionsSchema>;

const buildWorkflowRuntimeContextBase = (
  options: WorkflowCallOptions,
): AgentRuntimeContextBase => ({
  ...buildChatbotRuntimeContextBase(options),
  agentKey: `workflow:${options.workflowRunId}`,
  workflowRunId: options.workflowRunId,
  workflowAutonomy: options.workflowAutonomy,
  playbookBlock: options.playbookBlock,
});

const workflowSystemPrompt = (
  ctx: AgentRuntimeContext,
  tools: WorkflowTools,
): Promise<string> => {
  const registry = pickDomainRegistry(tools);
  // Don't advertise a gated write tool in `<domain_tools>` — the run can't
  // activate it (searchTools + step-gate withhold it), so listing it as
  // searchable only tempts a wasted turn. Stable per run (autonomy + policy are
  // fixed). Union the autonomy gate with the team's blocked-tool policy.
  const hidden = new Set<string>(policyHiddenToolNames(ctx));
  if (ctx.workflowAutonomy) {
    for (const n of workflowMainHiddenToolNames(ctx.workflowAutonomy))
      hidden.add(n);
  }
  const deferred =
    hidden.size === 0
      ? registry
      : Object.fromEntries(
          Object.entries(registry).filter(([name]) => !hidden.has(name)),
        );
  return buildWorkflowSystemPrompt(ctx, deferred);
};

/**
 * Progressive Disclosure + autonomy gate. Same per-step recompute as the
 * chatbot (`core + activated domain tools`), with the write gate layered on:
 *  - `read_only` — withhold every write tool (`manageRecord`/`manageLink`/
 *    `memory`); the run only reads.
 *  - `approval_required` — withhold the direct object-write tools
 *    (`manageRecord`/`manageLink`) so writes go through the gated Python SDK
 *    (`records.bulk_*`, which pauses on a `record_write` approval); `memory` stays.
 *  - `autonomous` — full tool set (direct writes).
 * A hard gate, not a prompt suggestion.
 */
const workflowPrepareStep = (
  tools: WorkflowTools,
): PrepareStepFunction<WorkflowTools> => {
  const coreNames = computeCoreToolNames(tools);
  const reanchorEvery = parseReanchorEverySteps();

  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    // `workflowAutonomy` is always set for this agent (required in call
    // options); the guard just satisfies the optional context type.
    const hidden = new Set<string>(policyHiddenToolNames(ctx));
    if (ctx.workflowAutonomy !== undefined) {
      for (const n of workflowMainHiddenToolNames(ctx.workflowAutonomy))
        hidden.add(n);
    }
    const activeTools = progressiveActiveTools(ctx, tools, coreNames, hidden);
    // Append-only re-anchor every K steps — a byte-stable prefix (the real
    // accumulated messages) plus a tiny tail the model re-reads this step
    // only. Never insert mid-history (that shifts every later token → cache
    // bust). stepNumber 0 is the turn's first step (already re-pinned by the
    // steering message), so start at the first multiple past it.
    if (
      stepContext.stepNumber > 0 &&
      stepContext.stepNumber % reanchorEvery === 0
    ) {
      return {
        activeTools,
        toolsContext: buildToolsContext(tools, ctx),
        messages: [
          ...stepContext.messages,
          { role: "user", content: REANCHOR_TEXT },
        ],
      };
    }
    return { activeTools, toolsContext: buildToolsContext(tools, ctx) };
  };
};

const makeWorkflowAgentSet = (
  model: ResolvedModel,
): AgentSet<WorkflowCallOptions, WorkflowTools> =>
  buildAgentSet<WorkflowCallOptions, WorkflowTools>({
    id: "workflow",
    buildTools: () => buildWorkflowTools({ dispatchAgent: dispatchAgentTool }),
    systemPrompt: workflowSystemPrompt,
    model,
    fallbackModel: resolveModel("chat-fallback"),
    stopWhen: [
      isStepCount(parseWorkflowTurnMaxSteps()),
      stopOnPendingApproval<WorkflowTools>(),
    ],
    maxOutputTokens: parseWorkflowStepMaxOutputTokens(),
    repairToolCall: llmRepairToolCall<WorkflowTools>(),
    prepareStep: workflowPrepareStep,
    buildRuntimeContextBase: buildWorkflowRuntimeContextBase,
    onRuntimeContext: (ctx, options) => {
      if (options.toolHints !== undefined && options.toolHints.length > 0) {
        // Pre-activate the playbook-declared tools at step 0 — but never a
        // gated one, so the session snapshot never advertises a withheld
        // write tool as callable (matches the step-gate + searchTools).
        const hidden = workflowMainHiddenToolNames(options.workflowAutonomy);
        const hints = options.toolHints.filter((h) => !hidden.has(h));
        if (hints.length > 0) ctx.dynamicToolManager.activate(hints);
      }
    },
    callOptionsSchema: WorkflowCallOptionsSchema,
  });

/** Per-replica memoization, one set per serving profile — mirrors
 * `getChatbotAgentSet`. No key → the `workflow` role binding. */
const memoWorkflowAgentSet = memoizeAgentSets(makeWorkflowAgentSet);

export const getWorkflowAgentSet = (
  profileKey?: string,
): AgentSet<WorkflowCallOptions, WorkflowTools> =>
  memoWorkflowAgentSet(
    profileKey === undefined
      ? resolveModel("workflow")
      : resolveChatModelForProfile(profileKey),
  );
